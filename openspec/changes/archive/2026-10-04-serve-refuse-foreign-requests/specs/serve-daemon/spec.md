## MODIFIED Requirements

### Requirement: Localhost-only security posture

The daemon SHALL NOT support authentication, TLS, or any non-loopback
binding in v0. The implementation SHALL refuse to start if `--host`
resolves to a non-loopback address (see the "`minifac serve` command"
requirement). Documentation SHALL state that the daemon is intended
for single-user local use and that exposing it on a network
interface is unsupported.

Because a loopback bind alone does not keep a web page the operator
visits from reaching the daemon, the daemon SHALL also refuse, before
routing, any request (static or `/api/`) whose `Host` header is absent or
is not `127.0.0.1`, `localhost` or `[::1]` at the bound port, with `403`
and `{ error: "forbidden_host" }` (DNS rebinding). On any method other
than `GET` and `HEAD`, it SHALL refuse a request that carries an `Origin`
header other than `http://` + one of those names at the bound port, with
`403` and `{ error: "forbidden_origin" }`; a request with no `Origin`
(a non-browser client) is not refused on that ground. `POST /api/runs`
SHALL refuse a request whose `Content-Type` media type is not
`application/json` (parameters such as `charset` are allowed) with `415`
and `{ error: "unsupported_media_type" }`, so a browser cannot send it
cross-origin without a CORS preflight, which the daemon never grants.

#### Scenario: No auth surface is exposed

- **WHEN** a contributor inspects the daemon's HTTP routes
- **THEN** no route accepts, requires, or processes credentials,
  cookies, or authorization headers

#### Scenario: Documentation calls out the local-only posture

- **WHEN** a user reads `README.md`'s `minifac serve` section
- **THEN** the section states the daemon binds loopback only and
  that wider exposure is unsupported in v0

#### Scenario: A DNS-rebinding Host is refused

- **WHEN** a client sends `GET /api/factories` (or `/api/runs`, or `/`)
  with `Host: rebind.evil.example:<bound port>`, or with a loopback name
  at another port
- **THEN** the daemon responds `403` with `{ error: "forbidden_host" }`

#### Scenario: A cross-origin POST is refused and starts no run

- **WHEN** a client POSTs a valid `{ factoryId, cwd }` to `/api/runs`
  with `Origin: https://evil.example`
- **THEN** the daemon responds `403` with `{ error: "forbidden_origin" }`
  and no run is started

#### Scenario: The daemon's own origin is accepted

- **WHEN** the viewer served at `http://localhost:<bound port>` POSTs a
  valid JSON body with `Origin: http://localhost:<bound port>`
- **THEN** the daemon starts the run and responds `201`

#### Scenario: A text/plain POST is refused and starts no run

- **WHEN** a client POSTs a JSON-shaped body to `/api/runs` with
  `Content-Type: text/plain`
- **THEN** the daemon responds `415` and no run is started
