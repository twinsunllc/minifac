## Context

`serve-and-viewer` shipped the `minifac serve` daemon, but a code
review identified two bugs that violate the canonical `serve-daemon`
spec or are silent footguns for the viewer client. This change fixes
those two — nothing else. The other review findings are catalogued in
**Open Questions / Deferred Follow-ups** so they aren't forgotten.

The two fixes share a theme: the SSE plumbing trusts that the
underlying HTTP machinery (or the client) will Do The Right Thing,
when in fact it doesn't. Both fixes are localised to `src/serve/`.

## Decisions

### Decision: Track active SSE writers in `RunRegistry`

**What.** Add a `Set<SseWriter>` (or equivalent) of active live
subscribers to `RunRegistry`. `subscribe(...)` registers the writer
when it attaches a live sink; the existing unsubscribe path removes
it. A new method (e.g. `closeAllSubscribers()`) walks the set and
calls `.close()` on each writer. `DaemonHandle.close()` invokes that
method before awaiting `server.close()`.

**Why here, not at the daemon level.** The registry already owns
per-run subscriber sets (`this.subscribers: Map<string, Set<Subscriber>>`).
The natural seam is to teach `Subscriber` to carry an optional
writer reference (or to store writers in a parallel set), and to give
the registry a "tear down everything" method that the daemon calls.
That keeps `server.ts` thin and avoids a second place to forget about
when a future endpoint also wants long-lived connections.

**Why not at the daemon level (the alternative).** A daemon-level
`Set<ServerResponse>` would work and would also handle non-SSE
long-lived responses if we ever add any. But we don't have any other
long-lived responses today, and putting the set in the registry
keeps the writer's lifetime tied to the same object that already
manages its lifecycle. If a third long-lived endpoint shows up later
we can promote the set to the daemon level then.

**Why pass the writer in rather than wrap the sink.** The sink is
already a function; wrapping it to know about the writer's `.close()`
is awkward and couples the sink type. Storing the writer alongside
the sink is cleaner.

**Shutdown ordering.** `DaemonHandle.close()` becomes:

```
watcher.close();
runs.closeAllSubscribers();   // ends in-flight SSE responses
await server.close();         // resolves once no live sockets
```

Closing writers first lets `server.close()`'s "wait for sockets to
drain" check complete. Without this, `server.close()` hangs.

### Decision: 400 on malformed `Last-Event-ID`

**What.** In `handleRunEvents`, distinguish three cases when reading
`Last-Event-ID`:

1. Header absent → `lastIndex = undefined`, behave exactly as today
   (replay buffered events from index 0, then live tail).
2. Header present and parses as a non-negative integer (including
   `0`) → `lastIndex = parsed`. Today's spec scenario already pins
   `Last-Event-ID: 5` ⇒ resume from index `> 5`; the same logic gives
   `Last-Event-ID: 0` ⇒ resume from index `> 0`, i.e. skip event 0.
3. Header present but unparseable (e.g. `abc`, `1.5`, `-1`, empty
   string, `"NaN"`) → HTTP 400 with `{ error: "invalid_last_event_id",
   message: "<...>" }` and no SSE upgrade.

**Why 400, not silent fallback.** The user gave the recommendation
("prefer 400") and the reasoning is solid: a silent fallback that
re-runs the entire event buffer is the *opposite* of what a
reconnecting `EventSource` is asking for. It is also indistinguishable
from "the server forgot my position", which is a bug class that's
hard to spot from the client. 400 surfaces the bug immediately.

**What counts as "parses".** A reasonable cut: `Number.parseInt(raw,
10)` finite *and* the original string matches `/^-?\d+$/` *and* the
parsed value is `>= 0`. We don't need to be exhaustive; the goal is
"reject the kinds of input that today's code silently swallows".
Floats are rejected because the spec only mentions integer indices,
and negative numbers are rejected because they're meaningless for a
0-based monotonic counter.

**Why no `EventSource` impact.** The browser's `EventSource` always
sends back the most recent `id:` it has seen (or omits the header on
first connect). It cannot emit a malformed value unless a caller is
hand-rolling SSE — exactly the case the 400 helps debug.

### Decision: New test for SIGINT-closes-SSE

**Shape.** Start a daemon with a slow scripted executor that yields
its first event after, say, 200ms and then sleeps for several
seconds. Start a run, open a `fetch()` against the SSE endpoint, wait
until the response body is readable (status 200, content-type set).
Then call `handle.close()` and assert the response stream ends
cleanly within a small bound (1 second). Without the fix, `close()`
never resolves and the test times out.

We do not need to actually send a `SIGINT` to the test process — the
CLI's signal handler just calls `handle.close()`, so calling it
directly exercises the same code path. The CLI signal-handler test
can remain as-is (it covers wiring, not the registry).

### Decision: Spec deltas

Two adjustments to `openspec/specs/serve-daemon/spec.md`:

1. **Modify** the `minifac serve` command requirement to say the
   daemon SHALL *actively terminate* in-flight SSE responses, not
   merely stop accepting new connections. The existing SIGINT
   scenario stays but its "THEN" is sharpened.
2. **Modify** the SSE event stream requirement to add a paragraph
   and a scenario for malformed `Last-Event-ID` → 400.

`MODIFIED Requirements` is the right OpenSpec verb here — we are
restating both requirements with tighter language, and OpenSpec's
delta convention asks for the full new requirement body when a
requirement is modified.

## Risks / Trade-offs

- **Closing SSE writers during shutdown could race with concurrent
  `recordEvent` fan-out.** `SseWriter.close()` flips an internal flag
  and the write path is `safeWrite`-guarded, so a concurrent `send`
  becomes a no-op rather than a throw. Reviewed and intentional.
- **Returning 400 on malformed `Last-Event-ID` is a client-visible
  contract.** A custom client that has been getting away with garbage
  values will now break. Acceptable: the existing behavior was
  silently wrong, and no first-party client we ship sends a malformed
  value.
- **Test flake on the SIGINT case.** Timing-based assertions can
  flake under load. We avoid this by using `fetch()` body streaming
  (Node 18+'s WHATWG fetch keeps the body open) and `Promise.race`
  with a generous timeout (e.g. 1500ms) — we're checking "did it
  finish at all", not "did it finish in <50ms".

## Migration

None. v0 daemon, no callers in production. Internal contract change
only.

## Open Questions / Deferred Follow-ups

These came out of the same review but are explicitly **not** in
scope for this change. They are listed here so the next round picks
them up rather than rediscovering them.

- **SSE heartbeat / keepalive.** Idle SSE connections behind proxies
  or load balancers get culled. A periodic `: keepalive\n\n` comment
  every ~15s would harden the viewer's live tail. Not load-bearing
  on localhost-only v0.
- **Safe-root check on `cwd`.** `POST /api/runs` accepts a `cwd`
  field. The previous design promised the daemon would refuse paths
  outside a configured root; today it only checks `path.isAbsolute`.
  Worth its own design pass.
- **Static path resolution refactor + percent-decode test.** The
  static handler resolves `./{pathname}` against `webRoot`. A
  percent-encoded `%2e%2e` in the URL is currently decoded by
  `new URL(...)` before we see it — worth pinning with a test, and
  worth refactoring out into a tested helper.
- **Trusting `Host` header for URL base.** `handleRequest` builds a
  `new URL(req.url, "http://" + req.headers.host ?? "127.0.0.1")`.
  The `Host` header is attacker-controllable in principle; we should
  bind to a known host. Localhost-only v0 keeps this low-risk.
- **Viewer reconnect UI feedback.** The viewer's `EventSource`
  auto-reconnects silently. Showing the user "reconnecting…" would
  catch the transient case where the daemon restarted and the viewer
  is replaying.
- **Refuse-to-start on missing watched directory.** Today the daemon
  starts even if the watched directory doesn't exist; `FactoryWatcher`
  surfaces an empty list. Refusing to start (or warning loudly) would
  match the user's mental model.
