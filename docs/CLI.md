---
tags: [reference]
aliases: [cli, command-reference]
---

# CLI Reference

Complete command reference for the `minifac` binary. Each section covers
synopsis, description, arguments, flags, exit codes, and examples. For
conceptual background on the terms used here see [[Brief]], [[Factory]],
[[Run]], [[Worktree]], and [[Runs-DB]].

## Commands at a glance

| Command | What it does |
|---|---|
| [`run`](#run) | Execute a factory against a brief (or directly by factory name) |
| [`init`](#init) | Bootstrap the directory layout in a new repo |
| [`brief`](#brief) | Author a new brief interactively or from a file |
| [`briefs`](#briefs) | List briefs with their doneness and activity state |
| [`merge`](#merge) | Merge a run's branch into the default branch |
| [`prune`](#prune) | Remove stale worktrees per the hybrid cleanup policy |
| [`runs`](#runs) | List persisted runs from `runs.db` |
| [`runs show`](#runs-show) | Print (or tail) the event log for one run |
| [`steps`](#steps) | List reusable step files |
| [`autorun`](#autorun) | Long-running daemon: poll `inputs/` and run ready briefs |
| [`serve`](#serve) | Start the local web viewer and HTTP API daemon |

---

## Global flags

```
minifac [options] [command]

Options:
  -V, --version   Output the version number
  -h, --help      Display help for command
```

---

## `run`

### Synopsis

```
minifac run [options] <thing>
```

### Description

Resolves `<thing>` as a brief path, a brief name, or a factory name and
executes the corresponding factory. When `<thing>` is a brief, minifac
creates an isolated [[Worktree]], claims a per-change lockfile, checks
`depends_on` deps, runs the factory graph, and moves the brief to
`inputs/done/` on success. When `<thing>` is a factory name, no brief is
loaded and the factory runs in a fresh worktree without marking anything
done. The run's exit code, stdout/stderr stream, and final status are all
recorded in [[Runs-DB]].

Resolution order for `<thing>`:
1. If it looks like a path (contains `/` or ends in `.md`) — load it as a
   brief file directly.
2. Otherwise try `inputs/<thing>.md` in the current working directory as a
   brief name.
3. Otherwise try `.minifac/factories/<thing>.yaml`, then
   `examples/<thing>.yaml` as a factory name.

### Arguments

| Argument | Description |
|---|---|
| `<thing>` | Brief path, brief name (resolved under `inputs/`), or factory name |

### Options

| Flag | Default | Description |
|---|---|---|
| `--in-place` | off | Skip [[Worktree]] creation; run the factory in the current working directory |
| `--raw` | off (auto) | Force raw `[nodeId] line` output even when stdout is a TTY |
| `--tui` | off (auto) | Force the interactive [[Run-TUI]] even when stdout is not a TTY |
| `--force` | off | Override a blocked-deps refusal. Does **not** bypass cycle detection |
| `--factory <name>` | (brief's declared factory) | Override the factory for this invocation. Only valid when `<thing>` resolves to a brief — see [[0020-Factory-Override-At-Invocation]] |

`--raw` and `--tui` are mutually exclusive. When neither is passed, the
TUI is used when stdout is a TTY; raw output is used otherwise (e.g. in CI).

`--in-place` is also implied when the brief's own frontmatter sets
`mode: "in-place"`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Run succeeded |
| `1` | Usage error, resolution failure, lock conflict, or worktree setup failure |
| `2` | Run failed (`node_failed`, `graph_drained`, `unknown_executor`, or `user_quit`) |
| `3` | Run failed due to budget exhaustion (`budget_exhausted`) |

### Environment variables

| Variable | Description |
|---|---|
| `MINIFAC_HOME` | Override the minifac state root (default `~/.minifac`). Affects where worktrees, locks, and `runs.db` are stored |
| `LANG` / `LC_ALL` / `LC_CTYPE` | Picked up by the TUI glyph selector; a UTF-8 locale enables Unicode spinners and status glyphs |

### Examples

Run a brief by name (brief file lives at `inputs/add-login.md`):

```
minifac run add-login
```

Run a brief with a factory override for a one-off A/B test:

```
minifac run add-login --factory sdd-experimental
```

Run a factory directly (no brief, no worktree branch tracking):

```
minifac run sdd
```

---

## `init`

### Synopsis

```
minifac init [options]
```

### Description

Bootstraps the minifac directory layout in the current working directory.
Creates `inputs/`, `.minifac/`, `.minifac/factories/`, and a README in
`.minifac/factories/`. Existing paths are preserved — the command is safe
to re-run.

### Options

| Flag | Default | Description |
|---|---|---|
| `--with-sdd` | off | Also write a starter `.minifac/factories/sdd.yaml` that extends the built-in `minifac:sdd` factory |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Succeeded (or already initialized) |
| `1` | A filesystem error prevented one or more paths from being created |

### Examples

Minimal init (inputs + .minifac skeleton):

```
minifac init
```

Init with a starter SDD factory config:

```
minifac init --with-sdd
```

---

## `brief`

### Synopsis

```
minifac brief [options] <name>
```

### Description

Authors a new [[Brief]] at `inputs/<name>.md` via a one-question-at-a-time
interactive prompt, or non-interactively from a YAML/JSON answers file. The
authoring flow mirrors the `/brief` skill in Claude Code — both surfaces
share the same question schema and produce the same file format. Running
`minifac brief` in a non-TTY without `--from` is an error.

During interactive mode, entering `:q` or sending EOF stops the session
early. A partial brief is written if `change` and `factory` were answered;
otherwise nothing is saved.

### Arguments

| Argument | Description |
|---|---|
| `<name>` | Change name, used as the default answer for the `change` frontmatter field and as the output filename |

### Options

| Flag | Default | Description |
|---|---|---|
| `--from <file>` | — | Non-interactive mode: read answers from a `.yaml`, `.yml`, or `.json` file |
| `--out <path>` | `inputs/<name>.md` | Override the output path |
| `--force` | off | Overwrite an existing brief file |

#### Answers file schema (for `--from`)

Required fields: `change`, `factory`, `background`, `what_to_do`,
`acceptance_criteria`. Optional: `out_of_scope`, `base_branch`, `model`.
Unknown keys are rejected.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Brief written successfully |
| `1` | File already exists and `--force` not passed; parse error in `--from` file; non-TTY stdin without `--from`; early exit without enough frontmatter to save |

### Examples

Interactive authoring:

```
minifac brief add-login
```

Non-interactive from a YAML answers file:

```
minifac brief add-login --from answers/add-login.yaml
```

---

## `briefs`

### Synopsis

```
minifac briefs [options]
```

### Description

Lists all briefs discovered in `inputs/` (active) and `inputs/done/` (done),
joined against [[Runs-DB]] for activity data. The default table shows change
name, doneness state, activity, dependency summary, and the last run's id,
branch, and end time. A brief can be active with `succeeded` activity when
the run landed but the file has not yet been moved to `inputs/done/` — this
is normal and expected.

### Options

| Flag | Default | Description |
|---|---|---|
| `--state <s>` | (all) | Filter by doneness: `active`, `done`, or `missing` |
| `--activity <s>` | (all) | Filter by activity: `none`, `running`, `succeeded`, or `failed` |
| `--ready` | off | Shortcut filter: active briefs with all deps satisfied and no in-flight or succeeded run |
| `--inputs <d>` | `<cwd>/inputs` | Override the inputs directory |
| `--json` | off | Emit a JSON array instead of a table |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Succeeded (including zero results) |
| `1` | Invalid filter value or could not open `runs.db` |

### Examples

Show all briefs:

```
minifac briefs
```

Show only briefs that are ready to run:

```
minifac briefs --ready
```

---

## `merge`

### Synopsis

```
minifac merge [options] <arg>
```

### Description

Merges the git branch produced by a run into the repository's default
branch. Accepts either a run-id prefix (6 or more hex characters, resolved
against [[Runs-DB]]) or a change name. The command verifies that the working
tree is clean, checks out the default branch if necessary, attempts a
fast-forward merge, and falls back to a merge commit if fast-forward fails.
If both fast-forward and merge-commit fail (conflicts), the merge is aborted
and the conflicting paths are printed.

Minifac detects the default branch by reading git's `origin/HEAD` or falling
back to a local `main`. To pin a specific branch, set `default_branch:` in
`~/.minifac/config.yaml` or `.minifac/config.yaml`.

### Arguments

| Argument | Description |
|---|---|
| `<arg>` | A run-id prefix (6+ hex chars) or a change name |

### Options

| Flag | Default | Description |
|---|---|---|
| `--ff-only` | off | Refuse the merge-commit fallback; fail if fast-forward is not possible |
| `--pick` | off | When multiple runs match a change name, show an interactive picker |
| `--force` | off | Allow merging a run whose status is not `succeeded` |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Branch merged successfully |
| `1` | Resolution failure, dirty working tree, checkout failure, fast-forward failure (with `--ff-only`), or merge conflict |

### Examples

Merge by change name (picks the single succeeded run for that change):

```
minifac merge add-login
```

Merge by run-id prefix:

```
minifac merge a3f7c9
```

---

## `prune`

### Synopsis

```
minifac prune [options]
```

### Description

Removes stale [[Worktree]] directories under `~/.minifac/worktrees/` (or the
configured `worktrees_dir`) per the hybrid cleanup policy defined in
[[0010-Worktree-Cleanup-Hybrid]]. Without flags, the default policy removes
worktrees whose branch has merged to the default branch and are older than
the configured age cutoff. `minifac run` performs a lazy best-effort prune
before each new run; explicit `minifac prune` is for intentional bulk
cleanup.

### Options

| Flag | Default | Description |
|---|---|---|
| `--all` | off | Remove fresh, merged-old, and unmerged-old worktrees (does not touch failed by default) |
| `--merged` | off | Remove worktrees whose branch has merged to the default branch (this is the implicit default policy) |
| `--older-than <duration>` | (config default) | Override the age cutoff. Format: `<int><m\|h\|d>` — e.g. `7d`, `12h`, `30m` |
| `--failed` | off | Also remove worktrees from failed runs |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Prune completed (some or zero worktrees removed) |
| `1` | Invalid `--older-than` format or config load error |

### Examples

Remove all merged worktrees older than the default cutoff:

```
minifac prune --merged
```

Remove everything older than 3 days, including failed runs:

```
minifac prune --all --older-than 3d --failed
```

---

## `runs`

### Synopsis

```
minifac runs [options]
```

### Description

Lists runs persisted in [[Runs-DB]], most recent first. The table shows id
prefix, change/factory label, status, start time, branch name, and duration.
A run is stored as `running` while in flight and updated to `succeeded` or
`failed` when it terminates; you may see `running` rows for abandoned runs if
the process was killed without a clean exit.

### Options

| Flag | Default | Description |
|---|---|---|
| `--factory <name>` | (all) | Filter by factory name |
| `--change <name>` | (all) | Filter by brief change name |
| `--status <s>` | (all) | Filter by status: `running`, `succeeded`, or `failed` |
| `--limit <n>` | `20` | Cap the number of rows returned |
| `--json` | off | Emit a JSON array instead of a table |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Succeeded (including zero results) |
| `1` | Invalid `--status` or `--limit` value, or could not open `runs.db` |

### Examples

List the 20 most recent runs:

```
minifac runs
```

Show only failed runs for a specific change:

```
minifac runs --change add-login --status failed
```

---

## `runs show`

### Synopsis

```
minifac runs show [options] <id>
```

### Description

Prints the persisted event log for a single run identified by its full UUID
or an unambiguous prefix. Events are rendered in the same `[nodeId] line`
format as the raw `run` output. A summary line (`[run] succeeded` or
`[run] failed (reason)`) is appended when the run has a terminal status.

`--follow` polls the store at ~250 ms intervals until the run reaches a
terminal status, making it useful for watching an in-flight run from a
second terminal. The poll loop stops automatically after reaching an internal
ceiling (approximately 150 seconds) to prevent indefinite blocking.

### Arguments

| Argument | Description |
|---|---|
| `<id>` | Full run UUID or an unambiguous prefix |

### Options

| Flag | Default | Description |
|---|---|---|
| `--follow` | off | Tail an in-flight run via short-interval polling; exits when the run reaches a terminal status |
| `--json` | off | Emit NDJSON — one JSON event object per line |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Log printed successfully (or poll ceiling reached with `--follow`) |
| `1` | Run not found, ambiguous prefix, or could not open `runs.db` |

### Examples

Print the log for a completed run:

```
minifac runs show a3f7c9b2
```

Tail an in-flight run:

```
minifac runs show a3f7c9b2 --follow
```

---

## `steps`

### Synopsis

```
minifac steps [options]
```

### Description

Lists reusable step YAML files discovered in `.minifac/steps/` (local) and
`examples/steps/` (built-in). The table shows name, version, source, and
description. Steps that fail to parse are listed with an error note rather
than being silently omitted. Local steps sort before built-in steps; within
each group, steps are sorted by name.

### Options

| Flag | Default | Description |
|---|---|---|
| `--source <s>` | `all` | Filter by source: `local`, `built-in`, or `all` |
| `--json` | off | Emit a JSON array instead of a table |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Succeeded (including zero results) |
| `1` | Invalid `--source` value |

### Examples

List all available steps:

```
minifac steps
```

List only local steps defined in this repo:

```
minifac steps --source local
```

---

## `autorun`

### Synopsis

```
minifac autorun [options]
```

### Description

Polls the inputs directory for ready [[Brief|briefs]] and runs them
automatically. Long-running by default; use `--once` for single-shot CI
pipelines. A brief is considered ready when its doneness is `active`, its
`depends_on` deps are all satisfied, and there is no currently running or
recently succeeded run for that change. Briefs are dispatched in mtime order
(oldest file first) up to `--max-concurrent` parallel slots.

Signal behavior: the first `SIGINT` or `SIGTERM` stops accepting new briefs
and waits for in-flight runs to finish. Pass `--force` to make the first
signal kill in-flight executors immediately (exit 2 if any were killed); a
second signal always kills immediately even without `--force`.

An `fs.watch` listener provides sub-interval wake-ups when new files appear;
polling continues at `--interval` as a fallback.

### Options

| Flag | Default | Description |
|---|---|---|
| `--watch <dir>` | `<cwd>/inputs` | Directory to poll for brief files |
| `--max-concurrent <n>` | `1` | Maximum number of parallel runs |
| `--interval <ms>` | `10000` | Poll cadence in milliseconds |
| `--once` | off | Run a single poll cycle, wait for all dispatched runs, then exit |
| `--filter <expr>` | (all) | Glob (e.g. `feat-*`) or `/regex/` matched against the brief's change name |
| `--dry-run` | off | Run a single poll cycle, print scheduling decisions, invoke no runs |
| `--json` | off | Emit log lines as one JSON object per line (includes a `startup` event with resolved options) |
| `--force` | off | On first `SIGINT`/`SIGTERM`, kill in-flight child executors instead of waiting for them to finish |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean stop (all in-flight runs finished normally) |
| `1` | Invalid options or could not open `runs.db` |
| `2` | Stopped with `--force` and at least one in-flight run was killed |

### Environment variables

| Variable | Description |
|---|---|
| `MINIFAC_HOME` | Override the minifac state root (affects `runs.db` path and lock directory) |

### Examples

Long-running daemon on the default inputs directory:

```
minifac autorun
```

CI one-shot with a glob filter:

```
minifac autorun --once --filter "feat-*"
```

Preview scheduling decisions without starting anything:

```
minifac autorun --dry-run
```

---

## `serve`

### Synopsis

```
minifac serve [options] [dir]
```

### Description

Starts the local minifac daemon, which provides a web-based run viewer and
an HTTP API backed by [[Runs-DB]]. The server runs until it receives
`SIGINT` or `SIGTERM`. The `[dir]` argument controls which directory the
server watches for factory YAML files (used by the web viewer's factory
browser).

**Loopback only.** The `--host` value is validated against an explicit
allow-list (`127.0.0.1`, `::1`, `localhost`, `::ffff:127.0.0.1`); any other
value is refused at startup with a clear error message. This is intentional:
the daemon has no authentication, no TLS, and no audit logging. Exposing it
on a network interface is a separate proposal — auth must land first.

### Arguments

| Argument | Default | Description |
|---|---|---|
| `[dir]` | `.` | Directory to watch for factory YAML files |

### Options

| Flag | Default | Description |
|---|---|---|
| `--port <number>` | `4280` | TCP port to bind |
| `--host <string>` | `127.0.0.1` | Loopback host to bind. Only `127.0.0.1`, `::1`, `localhost`, or `::ffff:127.0.0.1` are accepted — non-loopback values fail startup |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown after receiving `SIGINT` or `SIGTERM` |
| `1` | Invalid `--port`, non-loopback `--host`, or daemon failed to start |

### Examples

Start the viewer on the default port:

```
minifac serve
```

Bind to a different port and watch a specific directory:

```
minifac serve --port 4281 ./my-project
```

---

## Configuration reference

Most path-related defaults can be overridden in `~/.minifac/config.yaml`
(global) or `<repo>/.minifac/config.yaml` (per-repo). Per-repo settings
take precedence for `worktrees_dir` and `default_branch`; `locks_dir` is
machine-state and is only read from the global config.

| Key | Default | Description |
|---|---|---|
| `worktrees_dir` | `$MINIFAC_HOME/worktrees` | Where run worktrees are created |
| `locks_dir` | `$MINIFAC_HOME/locks` | Where per-change lockfiles are stored (global only) |
| `default_branch` | (auto-detected from `origin/HEAD` or `main`) | The branch `minifac merge` targets |
| `runs_db` | `$MINIFAC_HOME/runs.db` | Path to the SQLite run history database |

`MINIFAC_HOME` defaults to `~/.minifac` and can be overridden by the
environment variable of the same name.
