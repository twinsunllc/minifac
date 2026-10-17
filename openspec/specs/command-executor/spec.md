# command-executor Specification

## Purpose
TBD - created by archiving change command-executor. Update Purpose after archive.

## Requirements

### Requirement: Command executor is registered by default

The CLI's default executor registry SHALL register an executor whose `type` is the literal string `"command"`, beside `claude` and `check-merge`, and the package index SHALL export it as `CommandExecutor`. A node that declares `executor: command`, inline or through a resolved `uses:` step, SHALL find it without further setup. The executor SHALL declare `supportsMcp`, `supportsNudge` and `supportsResume` all `false`, and the last event it yields SHALL be a `status` event of `succeeded` or `failed`.

#### Scenario: Default registry resolves `executor: command`

- **WHEN** the CLI runs a factory whose step-inlined node declares `executor: command` with the default registry
- **THEN** the node runs and succeeds, and the run does not fail with `unknown_executor`

### Requirement: Command executor `with:` schema

The executor's `with:` SHALL be strict and SHALL accept:

- `commands` (required): a non-empty list of strict entries, each with `id` (required, matching `[a-zA-Z_][a-zA-Z0-9_-]*`, unique in the list), `run` (required, non-empty string), `cwd` (optional string), `timeout_seconds` (optional positive integer, default 600), `expect` (optional `{ exit: <int> | <non-empty int list> }`, default `{ exit: 0 }`) and `tool` (optional non-empty string);
- `continue_on_red` (optional boolean, default `false`);
- `result_from` (optional): the id of a declared command;
- `result_file` (optional string), not together with `result_from`;
- `secrets` (optional list), carried unread (a `uses:` node's `with.secrets` is merged into the inlined step).

Defaults SHALL be applied by the executor, not written into the loaded factory. At dispatch an invalid `with:` SHALL fail the node with `meta.reason: "invalid_with"` before any command runs.

#### Scenario: A full shape is accepted

- **WHEN** `with:` declares two commands, every optional command field, `continue_on_red`, `result_from` naming the second command and `secrets`
- **THEN** validation succeeds

#### Scenario: Invalid at dispatch

- **WHEN** the executor is handed `with: { commands: [] }`
- **THEN** it yields `failed` with `meta.reason: "invalid_with"` and runs nothing

### Requirement: Load-time validation of command nodes and steps

The step loader SHALL validate the `with:` of a step whose `executor` is `command`, and the factory loader SHALL validate the `with:` of every node whose resolved `executor` is `command` after `uses:` inlining. A violation SHALL be a load error (`StepLoadError` / `FactoryLoadError`) whose source path is the file and whose message names the key path under `with` (for example `with.commands[1].id`). At least these SHALL be load errors: an empty `commands` list, a duplicate command id, a `result_from` that names no command, `result_from` beside `result_file`, an unknown key, and a command without `run`. A node of any other executor SHALL NOT be validated against this schema.

#### Scenario: Duplicate id in an inline node

- **WHEN** a factory's inline `command` node lists two commands with id `a`
- **THEN** loading throws `FactoryLoadError` with that factory's path and a message containing `with.commands[1].id: duplicate command id`

#### Scenario: Dangling `result_from` in a step

- **WHEN** a step declares `executor: command` and `result_from: nope` with no command `nope`
- **THEN** loading the step throws `StepLoadError` with the step's path and a message containing `with.result_from`, and loading a factory that `uses:` it throws `FactoryLoadError` whose message contains the step's path and the key

#### Scenario: Other executors unchanged

- **WHEN** a `claude` node's `with:` carries `commands: []`
- **THEN** the factory loads

### Requirement: Ordered execution with stop-at-first-red

The executor SHALL run `commands` in declared order, each as `/bin/sh -c <run>` with stdin on `/dev/null`, in the directory `cwd` resolved against the node's cwd. A command SHALL be green iff it was spawned, did not time out, and exited with a code in `expect.exit`; a command ended by a signal SHALL be red. By default the executor SHALL stop at the first red command and later commands SHALL NOT run. With `continue_on_red: true` every command SHALL run. The node SHALL succeed iff every command that ran was green and the result parsed.

#### Scenario: Stop at first red

- **WHEN** three commands run and the second exits 1
- **THEN** the third does not run, the result has two entries and the node fails

#### Scenario: `continue_on_red`

- **WHEN** the same commands run with `continue_on_red: true`
- **THEN** all three run and the node fails

#### Scenario: Exit list

- **WHEN** a command exits 1 with `expect: { exit: [0, 1] }`
- **THEN** it is green

### Requirement: Process-group kill

Each command SHALL run in its own process group. At `timeout_seconds` the executor SHALL send SIGTERM to the group, then SIGKILL after a grace (5 s by default) if the command's shell has not exited, and mark the command `timed_out`; a timed-out command SHALL be red. When the shell exits, the executor SHALL send SIGKILL to its group. When the executor's event stream is abandoned before it ends, the running command's group SHALL be sent SIGKILL.

#### Scenario: Timeout kills a grandchild

- **WHEN** a command runs `sleep 60 &` and waits, with `timeout_seconds: 1`
- **THEN** the command is `timed_out` and red, and once the node ends the backgrounded `sleep` is no longer alive

#### Scenario: SIGTERM first

- **WHEN** a timed-out command traps SIGTERM and exits 0, with a grace longer than the test
- **THEN** it ends before the grace, its stdout shows the trap ran, and it is red

#### Scenario: Exited command's background process

- **WHEN** a command backgrounds `sleep 60` and exits 0
- **THEN** the command is green and the `sleep` is no longer alive after the node

### Requirement: `tool` resolution and `host_missing`

When a command declares `tool`, the executor SHALL resolve it before spawning: a value containing `/` as a path against the command's cwd, any other value on the child's `PATH`; it SHALL resolve only to an executable regular file. A command whose `tool` does not resolve SHALL be red with `host_missing: true` and `exit_code: null`, SHALL NOT be spawned, and SHALL appear in the result, including under `continue_on_red`.

#### Scenario: Absent tool

- **WHEN** a command declares `tool: definitely-not-a-binary-xyz`
- **THEN** its `run` is not executed, its entry is red with `host_missing: true`, and the node fails

### Requirement: Command result

The executor SHALL write `<outputs_dir>/result.json` whether the node succeeds or fails, holding the emitted keys (below) and `commands`: one entry per command reached, in order, each with `id`, `exit_code`, `signal`, `duration_ms`, `host_missing`, `timed_out`, `met`, `stdout_tail` and `stderr_tail`. Each tail SHALL be at most 8192 bytes by default and SHALL NOT begin mid-character. A node declaring `outputs: { result: { type: value } }` SHALL have the file indexed.

#### Scenario: Bounded tails

- **WHEN** a command writes more than 8192 bytes to stdout and to stderr
- **THEN** each tail is at most 8192 bytes and ends with the last line written

#### Scenario: Declared output indexed

- **WHEN** a succeeded `command` node declares a required `result` value output
- **THEN** a downstream `{{ priorResults.<id>.outputs.result:read }}` renders the file

### Requirement: Emitted result keys

With `result_from: <id>`, once that command has run, the executor SHALL parse its stdout, less every line matching `^REASON:`, as a JSON object. With `result_file`, it SHALL resolve the path against `run.outputs_dir`, refuse a path that lies outside it after symlinks are resolved, and parse the file as a JSON object. The object's keys SHALL be merged into the result, and the executor's `commands` SHALL replace an emitted `commands` key. JSON that does not parse, a non-object, an outside path, or a missing `result_file` when every command was green SHALL fail the node with the reason `result_parse: <command id or result_file>: <error>`.

#### Scenario: Keys merged

- **WHEN** the `result_from` command prints `{"clears_when":"x","resume_on_revise":true}`
- **THEN** the result carries `clears_when` and `resume_on_revise` beside `commands`

#### Scenario: Unparseable JSON names the command

- **WHEN** the `result_from` command `gate` prints `not json`
- **THEN** the node fails with a reason beginning `result_parse: gate:`

#### Scenario: Escaping result file

- **WHEN** `result_file` is `../escape.json`, or a symlink in the outputs dir to a file outside it
- **THEN** the node fails with `resolves outside run.outputs_dir` and nothing from the file is merged

### Requirement: Command failure reason

When the node fails, the executor SHALL yield `failed` with `meta: { reason: "command_failed", sentinel, commands }`, and the runner SHALL take `sentinel` as `NodeResult.reason`. `sentinel` SHALL be, in order of precedence: the `result_parse:` reason; the text after the last `REASON:` line a command that ran printed on stdout; a generated reason naming the first red command (`<id>: exit N, expected [..]`, `<id>: host_missing <tool>`, `<id>: timed out after Ns`, `<id>: killed by <signal>`, `<id>: failed to start: <error>`). A `REASON:` line SHALL NOT fail a node whose commands all met their expectation.

#### Scenario: plan_gate shape

- **WHEN** a `command` node with `result_from: gate` runs a script that prints a JSON object holding `clears_when` and `resume_on_revise`, prints `REASON: escalate: plan lists 40 files` and exits 1, with an `on_failure` edge to another node
- **THEN** the node fails, the edge is taken, the downstream node's `{{ priorResults.gate.reason }}` renders `escalate: plan lists 40 files`, and the result carries both keys

#### Scenario: Generated reason

- **WHEN** no command printed a `REASON:` line and the command `test` exited 2
- **THEN** the reason is `test: exit 2, expected [0]`

### Requirement: Command templates and shell safety

The runner SHALL render template tokens (`brief.*`, `run.*`, `inputs.*`, `priorResults.*`) in each command's `run` and `cwd` and in `result_file`, with the same grammar, pass-through rules and `TemplateSubstitutionError` cases as a `claude` prompt. In `run`, each resolved token SHALL be replaced by a double-quoted environment-variable reference (`"${MINIFAC_TOKEN_<n>}"`) and its value SHALL be passed in that command's environment; no value SHALL be spliced into the shell string. `claude` and `check-merge` `with:` substitution SHALL be unchanged.

#### Scenario: Hostile input

- **WHEN** a step-inlined node's input holds single and double quotes, `$(touch pwned)`, backticks, `${HOME}`, a newline and `; touch pwned3`, and its command runs `printf '%s' {{ inputs.title }} > {{ run.outputs_dir }}/out.txt`
- **THEN** `out.txt` holds exactly the input's bytes and no `pwned*` file exists

#### Scenario: `cwd` and `result_file` render

- **WHEN** a command's `cwd` is `{{ run.outputs_dir }}` and `result_file` is `{{ run.outputs_dir }}/r.json`
- **THEN** the command runs in the outputs dir and the file is read from it
