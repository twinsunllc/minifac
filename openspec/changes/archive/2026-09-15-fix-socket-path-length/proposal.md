## Why

The per-run MCP socket was bound at
`${MINIFAC_HOME}/outputs/<run-id>.mcp.sock`. `sun_path` is 104 bytes on
macOS (108 on Linux); with a deep `MINIFAC_HOME` the path overflowed,
`listen` failed with `EINVAL`, and the runner fell back to the
filesystem-JSON transport with one `stderr` event that nothing surfaced.
The `mcp__minifac__report_*` tools were simply absent from every session
in the run, which reads as "the model didn't call them" (issue #35;
scarif-factory FINDINGS F35).

## What Changes

- **FIXED** The socket lives in a fresh per-run directory under the OS
  temp dir (`os.tmpdir()`, which honors `$TMPDIR`):
  `<tmpdir>/minifac-<run-id-prefix>-XXXXXX/mcp.sock`. It no longer
  depends on `MINIFAC_HOME`. `mkdtemp` keeps concurrent runs distinct;
  the directory is removed with the socket at run termination.
- **FIXED** The runner checks the socket path against the platform
  `sun_path` limit *before* creating anything and refuses with an error
  naming the path, its byte length, the limit, and the `TMPDIR` remedy.
- **FIXED** Any MCP server start failure is loud: process stderr, the
  run's event stream, and the run log (`runs.db` events) all carry a
  line that says the `mcp__minifac__report_*` tools will be absent for
  this run.
- **MODIFIED** `graph-runner` "Per-run MCP server lifecycle": socket
  location, the length guard, the loud fallback; scenarios updated to
  the new path and two added (guard trips → fallback is loud; the
  fallback is recorded in the run log).

### Why the temp dir, not a configurable runtime dir

ADR 0029 D9 ("operators don't tune socket paths") still holds. The only
property the socket path needs is *short*, and `os.tmpdir()` is the
platform's answer to that; `$TMPDIR` is already the operator's knob when
it isn't. A `MINIFAC_RUNTIME_DIR` key would be a second knob for the
same thing.

## Impact

- `src/runner/mcp-server.ts`: `startRunnerMcpServer` no longer takes
  `outputsRoot`; gains `runtimeDir` (tests only), `maxSocketPathBytes`,
  `SocketPathTooLongError`. `runnerSocketPath` removed (unused outside
  the module).
- `src/runner/run.ts`: start-failure is written to `console.error` and
  replayed into the store once it is up.
- `docs/Config.md`, `docs/concepts/Outputs.md`: state-directory layout.
- Anything that assumed the socket sat next to the outputs tree. Nothing
  in-repo did except the tests.
