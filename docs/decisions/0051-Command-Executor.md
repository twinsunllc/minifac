---
status: accepted
date: 2026-10-17
supersedes: []
superseded-by: null
tags: [decision]
---

# 0051: A `command` executor

## Context

scarif-factory's `plan_gate` node spends about $0.43 and 90 s per run on a
model call whose only job is to run one Python script and relay its exit
status. Its `checks_gate` spends $0.55–1.37 per dispatch running a fixed
command list. The model in the middle has also mis-captured an exit status
(SETCO-603, SETCO-612). minifac had two executors: `claude` and the
read-only `check-merge` probe. Neither runs a declared command.

scarif-spec `openspec/changes/shared-factory-toolkit/design.md` §8.2 sketches
the `checks:` configuration such a gate would run (`id`, `run`, `tool`, a
`host_missing` outcome). Its open question 11 asks for exactly this:
commands without a model. That design rejected a `command` executor "now"
only because minifac had none (SCARIFW-2245, minifac#62).

## Decision

A third built-in executor, `command` (`src/executor/command.ts`), registered
in the CLI's default registry and exported from the package index. It
declares `supportsMcp`, `supportsNudge` and `supportsResume` all `false`.

### Shape

```yaml
executor: command
with:
  commands:                  # required, non-empty, run in order
    - id: gate               # required, unique, [a-zA-Z_][a-zA-Z0-9_-]*
      run: python3 bin/gate.py {{ priorResults.plan.outputs.result }}
      cwd: "{{ run.cwd }}"   # optional; relative to the node's cwd
      timeout_seconds: 600   # optional; default 600
      expect: { exit: 0 }    # optional; an int or a non-empty list; default 0
      tool: python3          # optional; must resolve or the command is host_missing
  continue_on_red: false     # optional; default false
  result_from: gate          # optional; a command id
  result_file: gate.json     # optional; under run.outputs_dir; not with result_from
```

`with:` is strict. A `secrets` list is also accepted and passed through
unread, because a `uses:` node's `with.secrets` is merged into the inlined
step ([[0046-Uses-Node-Secrets]]).

The same schema is checked at load time. The step loader checks a step
whose `executor` is `command`, and the factory loader checks every
`command` node after `uses:` inlining. An empty list, a duplicate id, a
`result_from` naming no command, `result_from` beside `result_file`, an
unknown key and a missing `run` are load errors. Each names the file and
the key path, for example `with.commands[1].id`. The executor re-checks at
dispatch and fails with `invalid_with`, as `check-merge` does.

### Running

- Each command is `/bin/sh -c <run>` in its own process group
  (`detached`), with stdin on `/dev/null`. Its environment is the runner's, plus
  the token variables below, plus `MINIFAC_OUTPUTS_DIR`.
- A `tool` containing `/` is a path, resolved against the command's cwd.
  Anything else is searched on the child's `PATH`. Either way it must be
  an executable regular file. A tool that does not resolve makes the
  command red with `host_missing: true` and `exit_code: null`. It is never
  spawned and never skipped: it appears in the result, red, under
  `continue_on_red` too.
- At `timeout_seconds` the whole group gets SIGTERM, then SIGKILL 5 s later
  if the shell is still alive. A timed-out command is red whatever it then
  exits with.
- When the shell exits, for any reason, the group gets SIGKILL. A process
  it backgrounded does not outlive the command. If something that left the
  group (with `setsid`) still holds the output pipes, the executor stops
  waiting for them after the same 5 s.
- When the run's abort signal fires (`RunOptions.abortSignal`, passed to
  the executor as `RunContext.abortSignal`), the running command's group
  gets SIGTERM, then SIGKILL after the same grace, and no further command
  starts, under `continue_on_red` too. A command already running when the
  signal fires is red whatever it then exits with, and its generated
  reason is `<id>: aborted`. The
  node then ends, and the runner reports the run as `user_quit`. The
  runner checks the signal only between events, so without this a silent
  command would run until it exited or timed out.
- If the consumer stops iterating the node's events before they end, the
  running command's group gets SIGKILL.
- Because each command is in its own process group, a signal sent to
  minifac's group (a terminal's Ctrl-C, a supervisor's SIGTERM) does not
  reach it. So the executor tracks the groups of the commands it has
  running and, from the first spawn on, SIGKILLs them on the process's
  `exit` and on SIGINT, SIGTERM and SIGHUP. Its signal listener is
  prepended. When no other listener exists, it removes itself and
  re-raises the signal, so the process still ends by that signal, as it
  did before. When the host process has its own listener, that listener
  goes on to decide what happens. `killAllCommandGroups()` is exported for
  an embedder that ends its process some other way. Nothing can run when
  minifac itself gets SIGKILL, so command groups survive that.
- A command is green iff it was spawned, did not time out, and its exit
  code is in `expect.exit`. A command ended by a signal has
  `exit_code: null` and is red. By default the node stops at the first red
  command; `continue_on_red: true` runs them all. The node succeeds iff
  every command that ran was green and the result parsed.

POSIX only: the group kill is `process.kill(-pid)`. Workers run macOS and
Linux.

### Result

The executor always writes `<outputs_dir>/result.json`, on success and on
failure. That is the file a `type: value` output named `result` resolves
to, so a node declaring `outputs: { result: { type: value } }` gets it
indexed (and, on failure, still addressable: [[0041-Failed-Node-Outputs]]).

```json
{ "...emitted keys": "...",
  "commands": [ { "id": "gate", "exit_code": 1, "signal": null,
                  "duration_ms": 412, "host_missing": false,
                  "timed_out": false, "met": false,
                  "stdout_tail": "…", "stderr_tail": "…" } ] }
```

- One entry per command reached, in order, a `host_missing` one included.
  Commands after a stopping red do not appear.
- `stdout_tail` and `stderr_tail` are each the last 8192 bytes of the
  stream, cut at a UTF-8 character boundary.
- Emitted keys come from `result_from`, that command's full stdout parsed
  as a JSON object, or from `result_file`, a JSON object file. `REASON:`
  lines are removed from `result_from` stdout before parsing, so one
  script can print its JSON and its reason. `result_from` stdout is kept up
  to 4 MiB; more than that is a parse failure. A `result_from` command
  that never ran (an earlier red stopped the node) emits nothing.
- `result_file` is resolved against `run.outputs_dir`, and after symlinks
  are resolved it must still lie inside it.
- JSON that does not parse, a non-object, a `result_file` outside the
  outputs dir, or a `result_file` missing when every command was green, is
  a node failure. The reason is `result_parse: <command id or result_file>:
  <error>`. A `result_file` that is missing while a command was red adds
  nothing.
- The executor's `commands` list always wins over an emitted `commands`
  key, with a `stderr` line saying so.

### Reason

When the node fails, its reason (`NodeResult.reason`,
`{{ priorResults.<id>.reason }}`) is, in this order:

1. the `result_parse:` reason, if the result failed to parse. A router
   acting on a script's reason would otherwise find none of the keys the
   script meant to send;
2. the text after the last `REASON:` line any command that ran printed on
   stdout (`/^REASON:[ \t]*(.*)$/`, the form `claude` nodes use);
3. a generated reason naming the first red command:
   `<id>: exit N, expected [0]`, `<id>: host_missing <tool>`,
   `<id>: timed out after Ns`, `<id>: killed by <signal>`,
   `<id>: aborted` or `<id>: failed to start: <error>`. A run aborted
   before any red command, with no command running, gives `aborted`.

A `REASON:` line does not fail a node by itself. A script that exits 0
while printing one succeeds. `plan_gate` must exit non-zero to escalate.

The executor's failure meta is `{ reason: "command_failed", sentinel,
commands }`, and the runner's `extractReason` accepts it beside
`sentinel_failed`.

### Templates and quoting

Tokens (`brief.*`, `run.*`, `inputs.*`, `priorResults.*`) render in each
command's `run` and `cwd` and in `result_file`, with the grammar,
pass-through rules and errors of a `claude` prompt.

In `run`, which is shell, no value is spliced. `substituteForShell`
(`src/runner/substitute.ts`) replaces each resolved token with
`"${MINIFAC_TOKEN_<n>}"`, a double-quoted variable reference, and the
runner hands the values to that command's child as environment variables
(`RunContext.commandEnv`, keyed by command id). A value therefore reaches
`/bin/sh` as one word of data, whatever quotes, `$()`, backticks or
newlines it holds. So:

- **Do not quote a token in `run`.** `printf '%s' {{ inputs.x }}` is right.
  Inside single quotes the reference is not expanded and the command
  sees the literal `"${MINIFAC_TOKEN_0}"`. Inside double quotes it still
  works.
- A token left verbatim (unknown namespace or field) stays verbatim.

`cwd` and `result_file` are paths, not shell, and render directly. Step
inlining substitutes `inputs.*` only in a step's top-level string `with:`
values. `commands` is a list, so its tokens wait for dispatch and go
through the shell-safe path.

## Rejected alternatives

- **Splicing values with shell quoting.** Correct quoting differs by
  context (inside double quotes, in a heredoc, after `=`), and one wrong
  site is an injection. An environment variable is data in every context.
- **A `shell` executor driven only by exit code** (the deferred note in
  [[Executor]]). It would have no per-command record, no `host_missing`,
  no emitted keys and no reason, so `plan_gate` could not move onto it.
- **`{changed:}` / `{mirror:}` placeholders and `red: added` in minifac.**
  In §8.2 those belong to the checks gate's own step (which files changed,
  what was red at the merge base), not to an executor. That step can
  compute them with commands this executor runs.
- **Failing the node when a script prints `REASON:` but exits 0.** Exit
  status is the contract the ticket names ("succeeds iff every command met
  its expectation"); a reason is only read when the node failed.
- **Reading defaults into the factory at load.** The loaded `with:` stays
  as written; the executor applies defaults. Snapshots of resolved
  factories do not change shape.

## Related

- [[Executor]]
- [[0041-Failed-Node-Outputs]]
- [[0046-Uses-Node-Secrets]]
- scarif-spec `openspec/changes/shared-factory-toolkit/design.md` §8.2 and
  open question 11
