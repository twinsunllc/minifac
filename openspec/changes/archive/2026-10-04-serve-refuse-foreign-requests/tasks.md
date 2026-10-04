## 1. Daemon

- [x] 1.1 `src/serve/server.ts`: `refuseForeignRequest` runs before routing
      and refuses a foreign `Host` (all methods) and a foreign `Origin`
      (non-`GET`/`HEAD`) with `403`
- [x] 1.2 `src/serve/server.ts`: `handlePostRun` refuses a non-JSON
      `Content-Type` with `415` before reading the body

## 2. Tests

- [x] 2.1 `src/serve/server.test.ts`: cross-origin `Origin` → `403` and no
      run; loopback `Origin` at another port → `403`; own `Origin` → `201`;
      rebinding `Host` → `403` on `/api/factories`, `/api/runs` and `/`;
      loopback `Host` at another port → `403`; every loopback name at the
      bound port → `200`; `text/plain` → `415` and no run;
      `application/json; charset=utf-8` → `201`

## 3. Docs

- [x] 3.1 `bearer.ignore`: the `resolveCwd` waiver describes the guarded path
- [x] 3.2 ADR 0047, CHANGELOG
