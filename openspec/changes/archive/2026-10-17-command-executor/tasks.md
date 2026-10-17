## 1. Substitution

- [x] 1.1 `src/runner/substitute.ts`: `substituteForShell` sharing one
      token resolver with `substitute`, whose output is unchanged
- [x] 1.2 `src/runner/substitute.test.ts`: env references, pass-through,
      priorResults tokens, a value carrying a token, the error cases

## 2. Executor

- [x] 2.1 `src/executor/command.ts`: `CommandWithSchema`,
      `validateCommandWith`
- [x] 2.2 `src/executor/command.ts`: `CommandExecutor` (process groups,
      timeout, post-exit kill, abort kill, `tool` resolution, tails,
      `result.json`, `result_from` / `result_file`, reason)
- [x] 2.3 `src/executor/command.test.ts`: the runtime scenarios

## 3. Loading

- [x] 3.1 `src/step/loader.ts` and `src/factory/loader.ts`: validate
      `command` steps and nodes
- [x] 3.2 `src/executor/command.load.test.ts`: every load error names the
      file and the key; other executors and the shipped examples unchanged

## 4. Runner and wiring

- [x] 4.1 `src/runner/run.ts`: render `commands[].run` (shell-safe),
      `commands[].cwd` and `result_file`; `RunContext.commandEnv`;
      `extractReason` accepts `command_failed`
- [x] 4.2 `src/cli.ts` default registry; `src/index.ts` exports
- [x] 4.3 `src/executor/command.e2e.test.ts`: shell safety, plan_gate
      routing, generated reason, output indexing, CLI default registry

## 5. Docs

- [x] 5.1 ADR 0051
- [x] 5.2 `docs/concepts/Executor.md`, `Factory.md`, `Step.md`
- [x] 5.3 CHANGELOG `[Unreleased]`
