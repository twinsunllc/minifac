## Why

scarif-factory's `plan_gate` spends about $0.43 and 90 s per run on a model
call whose only job is to run one Python script and relay its exit status,
and `checks_gate` spends $0.55–1.37 per dispatch running a fixed command
list. The model in the middle has also mis-captured an exit status
(SETCO-603, SETCO-612). minifac has no executor that runs a declared
command (SCARIFW-2245, minifac#62). scarif-spec's
`openspec/changes/shared-factory-toolkit/design.md` §8.2 and open question 11
are the prior art.

## What Changes

- **ADDED** capability `command-executor`: a `command` executor registered
  by default beside `claude` and `check-merge`.
- A strict `with:` schema (`commands[]` of `id`, `run`, `cwd?`,
  `timeout_seconds?` (600), `expect?` (exit 0), `tool?`; `continue_on_red?`,
  `result_from?`, `result_file?`), validated at load time in the step and
  factory loaders with errors naming the file and the key.
- Ordered execution in per-command process groups, killed at the timeout
  and after each command exits; `host_missing` for a `tool` that does not
  resolve.
- `<outputs_dir>/result.json` with one entry per command and bounded
  tails, merged with keys a command or a file emits.
- A `REASON:` line becomes the node's failure reason; otherwise a
  generated reason names the first red command.
- Template tokens render in `run`, `cwd` and `result_file`; in `run` they
  reach the shell as environment variables, never spliced.

## Impact

- Affected specs: new `command-executor`. `node-executor` ("Executor
  interface", "Executor validates its own `with:` payload") is honoured
  unchanged; `check-merge-step` is the precedent for a second built-in.
- Affected code: `src/executor/command.ts` (new), `src/runner/substitute.ts`
  (`substituteForShell`), `src/runner/run.ts` (render command fields,
  `extractReason`), `src/executor/types.ts` (`RunContext.commandEnv`),
  `src/factory/loader.ts`, `src/step/loader.ts`, `src/cli.ts`,
  `src/index.ts`.
- Additive: `claude` and `check-merge` nodes see byte-identical `with:` and
  behaviour.
- Docs: ADR 0051, `docs/concepts/Executor.md`, CHANGELOG.
