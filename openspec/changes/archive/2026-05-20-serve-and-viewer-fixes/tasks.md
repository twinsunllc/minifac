## 1. Track and close active SSE writers on shutdown

- [x] 1.1 In `src/serve/run-registry.ts`, teach `RunRegistry` (or its `Subscriber` shape) to hold an optional `SseWriter` reference alongside the existing `sink`. Update the `subscribe(...)` signature so callers can pass the writer, or expose a separate `attachWriter(...)` hook — pick whichever keeps the registry's API minimal.
- [x] 1.2 Add a `closeAllSubscribers()` method on `RunRegistry` that iterates every per-run subscriber set, calls `.close()` on each attached writer (no-op if the writer is already closed or absent), and clears the sets. The existing `unsubscribe` path remains correct for the normal client-disconnect case.
- [x] 1.3 In `src/serve/server.ts`, update `DaemonHandle.close()` to call `runs.closeAllSubscribers()` after `watcher.close()` and before awaiting `server.close()`. Confirm the ordering matches the design doc (subscribers first, then server).
- [x] 1.4 In `handleRunEvents` (`src/serve/server.ts`), pass the constructed `SseWriter` into the registry when subscribing so the registry can close it on shutdown. Keep the existing `req.on("close", ...)` path so client-initiated disconnects still unsubscribe and close cleanly.

## 2. Reject malformed `Last-Event-ID` with 400

- [x] 2.1 In `handleRunEvents` (`src/serve/server.ts`), extract a small `parseLastEventId(raw: string | undefined): { kind: "absent" } | { kind: "ok"; index: number } | { kind: "invalid"; raw: string }` helper (inline or top-level). It SHALL treat: `undefined` → `absent`; a string matching `/^-?\d+$/` parsing to a finite non-negative integer → `ok`; anything else (`"abc"`, `"1.5"`, `""`, `"-1"`, `"NaN"`) → `invalid`.
- [x] 2.2 On `kind: "invalid"`, send HTTP 400 with `{ error: "invalid_last_event_id", message: "Last-Event-ID must be a non-negative integer" }` and return without upgrading to SSE.
- [x] 2.3 On `kind: "absent"`, pass `undefined` to `runs.subscribe`. On `kind: "ok"`, pass the parsed index. Confirm `Last-Event-ID: 0` results in `subscribe(..., 0, ...)` and therefore replays from index `1` (matching the existing `lastIndex + 1` math in `RunRegistry.subscribe`).

## 3. Tests

- [x] 3.1 In `src/serve/server.test.ts` (or `run-registry.test.ts`), add a test that starts a daemon against a slow scripted executor (one that emits a stdout event then awaits a long timeout before yielding `status: "succeeded"`), POSTs a run, opens an SSE connection via `fetch()` and confirms the response is readable, then calls `handle.close()` and asserts the SSE response body ends within ~1s. The test SHALL fail against the current implementation and pass after task 1.
- [x] 3.2 In `src/serve/server.test.ts`, add a test that POSTs a run, then issues `GET /api/runs/:id/events` with header `Last-Event-ID: not-a-number` and asserts HTTP 400 with body `{ error: "invalid_last_event_id" }` and no `text/event-stream` content type.
- [x] 3.3 In `src/serve/server.test.ts`, add a test that lets a run accumulate at least two events, then opens an SSE connection with `Last-Event-ID: 0` and asserts that the streamed body does NOT contain the event at index `0` but does contain a subsequent event (e.g. event with `id: 1`).
- [x] 3.4 Run `npm test` (or the project's vitest invocation) and confirm all suites pass, including the new cases and the existing SSE happy-path test.

## 4. Spec delta

- [x] 4.1 Update `openspec/changes/serve-and-viewer-fixes/specs/serve-daemon/spec.md` to MODIFY the `minifac serve` command requirement so it states the daemon SHALL actively terminate in-flight SSE responses on shutdown, not merely stop accepting new connections. Keep the existing SIGINT scenario and tighten its THEN clause.
- [x] 4.2 Update the same spec delta to MODIFY the SSE event stream requirement to require 400 on malformed `Last-Event-ID`. Add a scenario that pins it.
- [x] 4.3 Run `openspec validate serve-and-viewer-fixes` and iterate until exit 0.
