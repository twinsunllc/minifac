## 1. Executor

- [x] 1.1 `src/executor/claude.ts`: `CLAUDE_EFFORT_LEVELS`; optional
      `effort` on `WithSchema`, refined to blank or a listed level
- [x] 1.2 `src/executor/claude.ts`: `buildCliArgs` emits
      `--effort <trimmed level>` after `--model` when non-blank
- [x] 1.3 Header comment: the argv order and an "Effort" section

## 2. Tests

- [x] 2.1 `claude.test.ts`: `--effort` sits after `--model`, before the
      authority flags and `with.args`; the value is trimmed
- [x] 2.2 `claude.test.ts`: absent, blank and whitespace emit no flag
- [x] 2.3 `claude.test.ts`: `turbo`, `HIGH` and a number fail
      `invalid_with` with no spawn; `""` and `high` spawn

## 3. Archive

- [ ] 3.1 `/opsx:archive` once merged
