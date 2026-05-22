## ADDED Requirements

### Requirement: `minifac runs show <id> --outputs` flag

The `runs show <id>` subcommand SHALL accept an `--outputs` flag
that augments the existing event-log output with a tree of
produced outputs for the resolved run.

When `--outputs` is supplied, after printing the event log (in
the existing format dictated by the `runs show` requirement),
the subcommand SHALL append a section to stdout in the following
shape:

```
Outputs for run <id>:
  <node-id> (iter <N>):
    <output-key> (<type>, <human-readable-size>)
    ...
  ...
```

where:

- The runs are grouped by `node_id ASC`, then `iteration ASC`,
  then `output_key ASC` (the order returned by
  `store.getNodeOutputs(runId)`).
- `<type>` is the literal `value`, `file`, or `directory`.
- `<human-readable-size>` is a SI-style formatted size (e.g.
  `412 B`, `18.2 KB`, `1.1 MB`). For `directory` outputs, the
  formatter SHALL additionally include the file count in
  parentheses (e.g. `directory, 4 files, 22.5 KB`).

When the run has no recorded outputs (pre-v3 run, or a v3+ run
where no node produced anything indexable), the section SHALL be:

```
Outputs for run <id>:
  (none)
```

The flag SHALL combine with `--follow` and `--json`:

- With `--follow`: the outputs section is appended only once, at
  the moment the run reaches a terminal state (so the tail loop
  doesn't reprint the section per polling pass). On a run that
  is already terminal when `--follow` is supplied, the section
  is printed at the end of the buffered events as the subcommand
  exits.
- With `--json`: instead of the human-readable tree, the
  subcommand SHALL emit a single trailing JSON line of the form
  `{"type":"outputs","rows":[<NodeOutputRow>, ...]}` where each
  row matches the `NodeOutputRow` shape from the `run-storage`
  capability's "`recordNodeOutputs` and `getNodeOutputs`"
  requirement. The line SHALL appear after every per-event JSON
  line for the run.

The flag SHALL NOT change exit-code semantics.

#### Scenario: `--outputs` prints a tree

- **WHEN** the user invokes `minifac runs show <id> --outputs`
  against a run with outputs from two nodes (`propose` iter 1,
  `apply` iter 1)
- **THEN** stdout contains the event log followed by an "Outputs
  for run <id>:" section listing both nodes with their iteration
  numbers and per-output `(<type>, <size>)` lines; the CLI
  exits `0`

#### Scenario: `--outputs` against a run with no outputs prints "(none)"

- **WHEN** the user invokes `minifac runs show <id> --outputs`
  against a run that produced no outputs (e.g. a pre-v3 run, or
  a brief-less smoke run)
- **THEN** stdout contains the event log followed by an "Outputs
  for run <id>:\n  (none)" section; the CLI exits `0`

#### Scenario: `--outputs --json` appends a trailing JSON line

- **WHEN** the user invokes `minifac runs show <id> --outputs --json`
  against a run with two output rows
- **THEN** stdout contains the per-event NDJSON lines followed
  by exactly one additional line whose parsed JSON is
  `{"type":"outputs","rows":[<row1>,<row2>]}` with `rows`
  ordered per `getNodeOutputs`; the CLI exits `0`

#### Scenario: `--outputs --follow` prints once at run termination

- **WHEN** the user invokes `minifac runs show <id> --outputs --follow`
  against a `running` run that subsequently produces outputs and
  terminates `succeeded`
- **THEN** stdout streams events as they arrive; the
  outputs-section is appended exactly once, after the terminal
  summary line, before the subcommand exits `0`

#### Scenario: Directory output formatting names file count

- **WHEN** a node produced a `directory` output containing 4
  files totalling 22500 bytes
- **THEN** the corresponding line in the `--outputs` tree reads
  approximately `<key> (directory, 4 files, 22.5 KB)` (or the
  closest SI-rounded equivalent)

### Requirement: `minifac runs cat <id> <selector>` subcommand

The CLI SHALL expose a `runs cat <id> <selector>` subcommand
that prints the contents of one produced output to stdout.

The positional `<id>` SHALL accept either a full run id or any
unambiguous prefix (same resolution rules as `runs show`).

The positional `<selector>` SHALL match one of:

- `<node-id>/<output-key>` — print the latest iteration's
  output for `(node-id, output-key)`.
- `<node-id>:<iteration>/<output-key>` — print the named
  iteration's output for `(node-id, output-key)`. `<iteration>`
  SHALL be a positive integer.
- `<node-id>/<output-key>/<filename>` — when the targeted output
  is `type: "directory"`, print the contents of the named file
  inside that directory.
- `<node-id>:<iteration>/<output-key>/<filename>` — combination
  of the above.

Behavior by output type:

- **`type: "value"`** — print the raw file contents (the
  JSON-on-disk shape). No pretty-printing is applied; the user
  who wants pretty JSON can pipe through `jq` or similar.
- **`type: "file"`** — print the raw file contents.
- **`type: "directory"`** without a trailing `/<filename>` —
  print a per-file listing in the shape:

  ```
  <directory-absolute-path>:
    <relative-path>  <size>
    <relative-path>  <size>
    ...
  ```

  ordered by recursive directory-walk order.
- **`type: "directory"`** with a trailing `/<filename>` — print
  the raw contents of that file inside the directory. The
  `<filename>` SHALL be interpreted relative to the directory
  output's root; the subcommand SHALL refuse to traverse
  outside that root (any `..` segment in `<filename>` is a
  usage error).

The subcommand SHALL exit:

- `0` on successful print.
- `1` on a usage error (malformed selector, ambiguous id,
  unknown id, unknown node id, unknown output key, unknown
  iteration, unknown filename, `..` traversal, fatal I/O).
- `1` when the named output is recorded in `runs.db` but the
  file on disk is missing (e.g. pruned away), with a stderr
  message naming the recorded path.

#### Scenario: Default selector picks latest iteration

- **WHEN** node `verify` ran iterations 1 and 2, both producing
  a `results` value output, and the user invokes
  `minifac runs cat <id> verify/results`
- **THEN** stdout contains the raw contents of iteration 2's
  `results.json`; the CLI exits `0`

#### Scenario: Explicit iteration selector

- **WHEN** the user invokes `minifac runs cat <id> verify:1/results`
  against the same run
- **THEN** stdout contains the raw contents of iteration 1's
  `results.json`; the CLI exits `0`

#### Scenario: Directory selector lists files

- **WHEN** node `verify` produced a `logs` directory output
  containing three files, and the user invokes
  `minifac runs cat <id> verify/logs`
- **THEN** stdout contains the directory's absolute path on the
  first line, followed by one indented line per contained file
  naming its relative path and size; the CLI exits `0`

#### Scenario: Directory selector with filename prints that file

- **WHEN** node `verify` produced a `logs` directory containing
  `run.log`, and the user invokes
  `minifac runs cat <id> verify/logs/run.log`
- **THEN** stdout contains the raw contents of
  `<verify-logs-dir>/run.log`; the CLI exits `0`

#### Scenario: Directory selector rejects path traversal

- **WHEN** the user invokes `minifac runs cat <id> verify/logs/../../etc/passwd`
- **THEN** the CLI writes a usage error to stderr naming the
  offending `..` and exits `1`; no file is read

#### Scenario: Malformed selector is a usage error

- **WHEN** the user invokes `minifac runs cat <id> not-a-selector`
  (no `/`)
- **THEN** the CLI writes a usage error to stderr explaining the
  selector grammar and exits `1`

#### Scenario: Unknown node or key is a usage error

- **WHEN** the user invokes `minifac runs cat <id>
  nonexistent/findings` against a run with no `nonexistent` node
- **THEN** the CLI writes a stderr message naming the unknown
  node and exits `1`

#### Scenario: Missing on-disk file is a runtime error

- **WHEN** the user invokes `minifac runs cat <id> propose/findings`
  against a run whose `node_outputs` row recorded a path that
  no longer exists on disk (e.g. the iteration directory was
  pruned manually)
- **THEN** the CLI writes a stderr message naming the recorded
  path and exits `1`

## MODIFIED Requirements

### Requirement: `minifac prune` subcommand

The CLI SHALL expose a `prune` subcommand that delegates to the
`worktree-management` capability's hybrid policy and flag matrix
(see that capability's "`minifac prune` subcommand flag matrix"
requirement). The subcommand SHALL accept the flags `--all`,
`--merged`, `--older-than <duration>`, `--failed`, and `--outputs`,
in any combination.

The subcommand SHALL NOT require a brief or a factory. It operates
purely on the `worktrees_dir`, the failed-run journal, and (when
`--outputs` is supplied) on the per-run output directory tree
plus `runs.db`.

By default (without `--outputs`), the subcommand behaves as
documented today: it processes the worktree directory only. The
`--outputs` flag is purely additive — it does not alter worktree
classification or removal behavior, and it does not require
`--outputs` to be supplied alongside any other flag.

When `--outputs` is supplied, the subcommand SHALL additionally
process the `${MINIFAC_HOME}/outputs/` tree, applying the same
hybrid classification policy used for worktrees:

- **Source of truth for run status:** `runs.db`. A run whose
  stored status is `running` is NEVER eligible for pruning
  regardless of any other classification (matches today's
  worktree policy of never pruning fresh-in-progress dirs).
- **Source of truth for age:** the filesystem `mtime` of the
  per-run outputs directory (`${MINIFAC_HOME}/outputs/<run-id>/`).
- **Classification buckets:** mirroring the worktree buckets,
  the subcommand SHALL classify each per-run outputs directory
  into `merged-old`, `unmerged-old`, `fresh`, or `failed` using
  the same age-and-status rules.
- **Default invocation (no other flags):** remove every
  `merged-old` outputs directory; keep all others.
- **`--all`:** add `unmerged-old` and `fresh` outputs
  directories; `failed` remains excluded unless `--failed` is
  also supplied.
- **`--failed`:** ALSO remove `failed` outputs directories.
- **`--older-than <duration>`:** overrides the default 7-day
  age cutoff for outputs classification, identically to its
  effect on worktree classification.

For every per-run outputs directory selected for removal, the
subcommand SHALL `rm -rf <dir>` and DELETE the corresponding rows
from `node_outputs` (filtered by `run_id`). The `runs`,
`events`, and `node_executions` rows for the run SHALL be
preserved (the run's event log remains queryable after its
outputs are reclaimed).

After processing, the CLI SHALL write a one-line summary to
stdout naming the removed-per-bucket counts for worktrees AND
(when `--outputs` was supplied) for outputs directories. The two
counts SHALL be reported separately so the operator can tell
which side of the prune did work.

The subcommand SHALL exit `0` on successful processing (including
when zero directories are removed). It SHALL exit `1` only on
usage errors (e.g. unparseable `--older-than` duration) or on a
fatal I/O error while scanning `worktrees_dir` or
`${MINIFAC_HOME}/outputs/`.

When a worktree directory cannot be removed (e.g. permission error,
in-use lock file inside), the subcommand SHALL surface the per-
directory failure on stderr and SHALL continue processing the
remaining directories; it SHALL NOT abort on first failure. The
same rule applies to outputs directories when `--outputs` is
supplied.

#### Scenario: Prune with no flags removes only merged-old

- **WHEN** the user invokes `minifac prune` and the worktrees
  directory contains one of each classification bucket (`fresh`,
  `merged-old`, `unmerged-old`, `failed`)
- **THEN** only the `merged-old` directory is removed; the CLI
  exits `0`; stdout contains a one-line summary naming the
  removed-per-bucket counts

#### Scenario: Prune surfaces per-directory removal failure

- **WHEN** `minifac prune` selects two directories for removal
  and the `git worktree remove --force` invocation for the first
  exits non-zero AND the `rm -rf` fallback also fails (e.g.
  permission denied)
- **THEN** the CLI writes a stderr line naming the failed
  directory and the underlying error, continues to process the
  second directory, and exits `0` (the run as a whole succeeded
  modulo the noted failure)

#### Scenario: Unparseable --older-than is a usage error

- **WHEN** the user invokes `minifac prune --older-than nonsense`
- **THEN** the CLI writes a usage error to stderr explaining the
  duration syntax (`<int><m|h|d>`) and exits `1`; no directories
  are touched

#### Scenario: `--outputs` removes merged-old outputs directories

- **WHEN** the user invokes `minifac prune --outputs` and the
  outputs tree contains per-run directories classified as
  `fresh`, `merged-old`, `unmerged-old`, and `failed`
- **THEN** only the `merged-old` outputs directory is removed
  (mirroring the worktree default); the `node_outputs` rows for
  the removed run id are DELETEd from `runs.db`; the run's
  `runs` / `events` / `node_executions` rows are preserved; the
  CLI exits `0`; the summary line names the removed-outputs
  count separately from the removed-worktrees count

#### Scenario: `--outputs --all --failed` reclaims everything

- **WHEN** the user invokes `minifac prune --outputs --all --failed`
- **THEN** every per-run outputs directory regardless of bucket
  is removed and its `node_outputs` rows are DELETEd; the
  worktree side of the prune behaves per its own flag
  semantics; the CLI exits `0`

#### Scenario: `--outputs` never touches running runs

- **WHEN** the user invokes `minifac prune --outputs --all --failed`
  and a run is currently `running` in `runs.db` with an
  outputs directory on disk
- **THEN** the running run's outputs directory is NOT removed;
  its `node_outputs` rows are preserved; only terminated runs'
  outputs directories are eligible for reclamation

#### Scenario: `--outputs --older-than` overrides the age cutoff

- **WHEN** the user invokes `minifac prune --outputs --older-than 30d`
  and an outputs directory is 10 days old for a `merged`
  (succeeded) run
- **THEN** classification treats that directory as `fresh`
  (10d < 30d) and it is NOT removed
