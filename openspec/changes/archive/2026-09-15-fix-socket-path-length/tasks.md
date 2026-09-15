## 1. Fix

- [x] 1.1 `startRunnerMcpServer`: bind under
      `mkdtemp(<tmpdir>/minifac-<run-id[:8]>-)`; drop `outputsRoot`;
      remove the directory on `close()` and on bind failure
- [x] 1.2 Guard the candidate path against `maxSocketPathBytes()`
      (104 darwin/BSD, 108 otherwise) before `mkdtemp`; throw
      `SocketPathTooLongError` naming path, bytes, limit, `TMPDIR`
- [x] 1.3 `runFactory`: on start failure, `console.error` the line,
      emit it on the event stream, and append it to the store once
      the store is ready

## 2. Tests

- [x] 2.1 Socket is under `os.tmpdir()`/`minifac-<id>-*`, not under
      `outputsRoot`; file and directory gone on `close()`
- [x] 2.2 Exactly-at-limit path binds; one byte over rejects with the
      named path/limit and leaves no directory behind
- [x] 2.3 `maxSocketPathBytes` per platform
- [x] 2.4 e2e: deep `TMPDIR` → run still succeeds via files; `__mcp__`
      stderr event and `console.error` both name the absent tools

## 3. Docs

- [x] 3.1 `docs/Config.md` layout, `docs/concepts/Outputs.md`

## 4. Verify

- [x] 4.1 tsc, `npm run check`, `npm test`,
      `openspec validate --all --strict`
