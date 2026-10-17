## 1. Schema and contract

- [x] 1.1 `src/factory/schema.ts`: `EdgeSchema.when` accepts `on_error`
- [x] 1.2 `src/executor/types.ts`: `NodeOutcome`; `outcome` on the
      `status` event and on `NodeResult`; exported from `src/index.ts`

## 2. Executors

- [x] 2.1 `claude.ts`: `invalid_with`, `spawn_error`, `missing_binary`,
      and no-sentinel non-zero exit or `is_error` result are errors
- [x] 2.2 `command.ts`: no exit code, timeout, abort, `result_parse` and
      `invalid_with` are errors; an unmet `expect.exit` is a failure
- [x] 2.3 `check-merge.ts`: `invalid_with`, `missing_base`,
      `missing_base_ref`, `git_error` are errors

## 3. Runner

- [x] 3.1 `run.ts`: outcome per dispatch; `on_error` routing with
      `on_failure` fallback; runner error paths; outcome on
      `priorResults`, `log`, `recordNodeEnd` and status events
- [x] 3.2 `result.ts`: `ExecutionLogEntry.outcome`
- [x] 3.3 `resume.ts`: rebuild `NodeResult.outcome` from the row

## 4. Storage

- [x] 4.1 `0006_add_node_outcome.sql` and its inline copy
- [x] 4.2 `run-store.ts`, `sqlite.ts`: write and read `outcome`

## 5. Tests

- [x] 5.1 `loader.test.ts`: accepts `on_error`; unknown `when` lists all
      three; `on_error` cycle needs a budget
- [x] 5.2 `claude.test.ts`, `command.test.ts`, `check-merge.test.ts`:
      the mappings
- [x] 5.3 `run.on-error.test.ts`: crash with and without `on_error`,
      timeout, judged failure, budgets, runner error paths, records
- [x] 5.4 `sqlite.test.ts`, `resume.test.ts`: v6 migration, round-trip,
      resume rebuild

## 6. Docs

- [x] 6.1 ADR 0052, `docs/concepts/Factory.md`, `docs/concepts/Executor.md`,
      `docs/concepts/Cycle.md`, CHANGELOG
- [x] 6.2 Fold the deltas into `openspec/specs/`
