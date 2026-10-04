## Why

`minifac serve` binds loopback only, and ADR 0047's waiver of Bearer's
CWE-22 finding in `resolveCwd` relies on every `cwd` reaching the runner
being the operator's own, including one sent to `POST /api/runs`. That
premise was false: the daemon checked no `Host`, `Origin` or
`Content-Type`, so any web page the operator visited could send a
cross-origin `text/plain` POST and start one of the operator's factories in
a directory of its choosing, and a DNS-rebinding page could also read
`/api/factories`, `/api/runs` and run events (SCARIFW-1550 security review,
MF1).

## What Changes

- **MODIFIED** `serve-daemon` "Localhost-only security posture": before
  routing, the daemon refuses a `Host` that is not `127.0.0.1`,
  `localhost` or `[::1]` at the bound port (`403`); on any method other
  than `GET`/`HEAD` it refuses an `Origin` other than the daemon's own
  loopback origin (`403`); `POST /api/runs` refuses a non-JSON
  `Content-Type` (`415`).

## Impact

- Affected specs: `serve-daemon`
- Affected code: `src/serve/server.ts` (`handleRequest`, `handlePostRun`)
- The bundled viewer (`src/serve/web/app.js`) already sends
  `Content-Type: application/json` from the daemon's own origin, so it is
  unaffected. A client that sends a `Host` naming the machine's LAN name or
  another alias for loopback is now refused.
