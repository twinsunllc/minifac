## Why

The `serve-and-viewer` change shipped the `minifac serve` daemon, the
HTTP/SSE API, and the bundled web viewer. A code review of that change
flagged two correctness bugs in the SSE plumbing that need to land
before serve-and-viewer can be considered done:

1. **SIGINT does not actually close in-flight SSE streams.** The
   canonical `serve-daemon` spec promises that SIGINT closes any open
   SSE streams. The current implementation calls `server.close()`,
   which stops accepting *new* connections but lets existing SSE
   subscribers hold the daemon open indefinitely. The spec is violated
   in practice; an interactive viewer subscribed to a long-lived run
   blocks shutdown.

2. **Malformed `Last-Event-ID` silently replays from index 0.** The
   parse path in `handleRunEvents` treats `parseInt("abc")` (which
   returns `NaN`) the same as an absent header, so a garbage value
   sends the subscriber back to the start of the event log — the
   opposite of what a reconnecting client wants and a debugging
   nightmare because the bug is silent.

Both items came directly from the review. This proposal does only
those two fixes — anything else surfaced in the review (heartbeats,
safe-root cwd checks, static path resolution refactor, reconnect UI,
etc.) is deferred to its own change.

## What Changes

- **Track active SSE writers and close them on shutdown.** Maintain
  a set of live `SseWriter`s associated with each run (and/or
  daemon-wide). When `DaemonHandle.close()` runs — and therefore when
  the CLI's SIGINT/SIGTERM handler invokes it — each live writer
  SHALL have `.close()` called on it before `server.close()` resolves,
  so the daemon exits promptly instead of hanging on long-poll SSE
  connections.
- **Reject malformed `Last-Event-ID` with HTTP 400.** Distinguish
  "header absent" (no `Last-Event-ID` → start from the beginning of
  the buffer) from "header present but unparseable" (`Last-Event-ID:
  abc` → 400 Bad Request with a clear error body). The header `0`
  continues to mean "resume from index 1" (i.e., skip the event at
  index 0), matching how the spec scenario for `Last-Event-ID: 5`
  reads today.
- **Tests covering both fixes.** Add a test that proves SIGINT-style
  `close()` terminates an active SSE subscriber within a tight bound,
  and tests that pin the 400 behavior for malformed `Last-Event-ID`
  and the resume-from-1 behavior for `Last-Event-ID: 0`.
- **Spec tightening.** Modify the `minifac serve` command requirement
  to make "closes in-flight SSE streams" explicit about *active
  termination* rather than just `server.close()`. Add a requirement
  scenario pinning the malformed-header 400 behavior under the SSE
  event stream requirement.

Explicitly **out of scope** for this change (each is a real review
finding but deferred):

- SSE heartbeat / keepalive frames.
- A "safe root" check on `cwd` passed to `POST /api/runs`.
- Refactor of static path resolution and a percent-decode test.
- Honoring vs. ignoring the `Host` header when constructing URLs.
- Viewer-side reconnect feedback when the SSE stream drops.
- Refusing to start the daemon when the watched directory is missing.

These are listed as deferred follow-ups in `design.md` so the next
change picks them up without rediscovery.

## Capabilities

### Modified Capabilities

- `serve-daemon`: the SIGINT-closes-SSE requirement is tightened to
  spell out active termination; a new scenario pins malformed
  `Last-Event-ID` handling.

## Impact

- **`src/serve/server.ts`:** the daemon (or `RunRegistry`) tracks
  active SSE writers; `DaemonHandle.close()` walks the set and closes
  each one before resolving. The `Last-Event-ID` parse path returns
  400 on unparseable input instead of silently falling through to
  `undefined`.
- **`src/serve/run-registry.ts`:** likely the natural home for the
  active-writer set since the registry already owns per-run
  subscribers; the exact placement is settled in `design.md`.
- **Tests under `src/serve/`:** new cases in `server.test.ts` (and/or
  `run-registry.test.ts`) for SIGINT-closes-SSE and the two
  `Last-Event-ID` cases. The existing happy-path SSE test should
  continue to pass unchanged.
- **No new dependencies, no schema changes, no UI changes.** The
  viewer's `EventSource` already handles reconnect; the server-side
  semantics tighten under it.
- **No runner changes.** This is purely an HTTP-layer fix; the
  graph runner, factory schema, and CLI surface are untouched.
