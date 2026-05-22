# check-merge-step Specification

## Purpose
TBD - created by archiving change check-merge-step. Update Purpose after archive.
## Requirements
### Requirement: Check-merge executor is registered by default

The default executor registry built by the CLI (per the `node-executor` capability's "Executor interface" requirement) SHALL register a `check-merge` executor alongside `claude`. A factory node that declares `executor: check-merge` (whether directly inline or via a resolved `uses:` step) SHALL find a matching executor in the registry without further setup; the run SHALL NOT fail with `unknown_executor` for `check-merge` under the default registry.

The executor's `type` field SHALL be the literal string `"check-merge"`. The executor SHALL conform to the `NodeExecutor` interface defined in the `node-executor` capability: it SHALL expose a `run(node, ctx)` method that returns an async iterable of node events, and the final event yielded SHALL be a `status` event of either `succeeded` or `failed`.

#### Scenario: Default registry resolves `executor: check-merge`

- **WHEN** the CLI builds its default executor registry and a loaded factory contains a node with `executor: check-merge`
- **THEN** the runner finds an executor whose `type === "check-merge"` and uses it; the run does not fail with `unknown_executor` for that node

#### Scenario: Check-merge executor terminates with a status event

- **WHEN** the check-merge executor finishes a probe (clean or conflicting)
- **THEN** the last event in its async iterable is a `status` event whose `status` is either `succeeded` or `failed`

### Requirement: Check-merge executor `with:` schema

The check-merge executor's `with:` object SHALL accept exactly two optional fields and SHALL be strict on extras:

- `base` (optional, string): the branch (or any ref) the probe merges into. If absent or the empty string after substitution, the executor SHALL emit a `failed` status with a message instructing the operator to declare `with: { base: <branch> }` explicitly or run from a worktree whose `run.base_branch` is set.
- `mode` (optional, string): one of the literal strings `"any-merge"` or `"fast-forward"`. Defaults to `"any-merge"` when absent. Any other value SHALL be rejected as a validation failure.

The schema SHALL reject any other key in `with:`. The validation error SHALL be surfaced as a `status: "failed"` event with a `meta` field naming the offending key (matching the `claude` executor's `with:` validation pattern under the `node-executor` capability's "Executor validates its own `with:` payload" requirement).

#### Scenario: Missing base after substitution fails with a clear message

- **WHEN** the executor runs against a node whose resolved `with.base` is the empty string (e.g. the run had no base branch and the `{{ run.base_branch }}` default substituted to `""`)
- **THEN** the executor yields a `status: "failed"` event whose message instructs the operator to declare `base` explicitly, and produces no other event beyond the conventional `started` status

#### Scenario: Unknown `mode` value is rejected

- **WHEN** the executor runs against a node whose resolved `with.mode` is the literal string `"rebase"` (or any value not in the documented set)
- **THEN** the executor yields a `status: "failed"` event whose message names the offending value and lists the supported set (`"any-merge"`, `"fast-forward"`)

#### Scenario: Unknown `with:` key is rejected

- **WHEN** the executor runs against a node whose resolved `with` includes a key other than `base` or `mode` (e.g. `strategy`)
- **THEN** the executor yields a `status: "failed"` event whose message names the offending key

#### Scenario: Default `mode` is any-merge

- **WHEN** the executor runs against a node whose resolved `with` omits `mode`
- **THEN** the executor behaves as if `mode: "any-merge"` were declared

### Requirement: Check-merge executor probes mergeability without side effects

The check-merge executor SHALL determine whether merging `HEAD` of its resolved `cwd` worktree onto the configured `base` would produce conflicts. The probe SHALL be read-only: after the probe completes (whether the outcome is success or failure), the worktree's state SHALL be byte-for-byte equivalent to its state immediately before the probe. Specifically:

- `HEAD` SHALL point to the same commit.
- The index (as observed by `git status --porcelain`) SHALL be identical.
- The set of untracked files SHALL be unchanged.
- No `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`, or `AUTO_MERGE` files SHALL exist in `.git/` if they did not exist before; if they did exist before, their contents SHALL be unchanged.

The executor SHOULD use `git merge-tree --write-tree <base> <head>` (or the equivalent modern read-only plumbing) as the primary probe because it touches only the object database and does not require an in-tree merge. When that command is unavailable (e.g. an older `git` whose `merge-tree` does not accept `--write-tree`), the executor MAY fall back to a `git merge --no-commit --no-ff <base>` followed by `git merge --abort`, run inside a `finally`-style cleanup block to ensure the worktree-clean invariant holds even on abnormal termination paths.

The probe SHALL run in the resolved `cwd` for the node (per the `node-executor` capability's "Executor interface" requirement); the executor SHALL NOT consult any other directory.

#### Scenario: Worktree state is unchanged after a clean probe

- **WHEN** the check-merge executor runs a probe whose outcome is success on a worktree
- **THEN** `HEAD`, the porcelain status, the untracked-file set, and the absence-or-contents of `.git/MERGE_HEAD` / `.git/MERGE_MSG` / `.git/MERGE_MODE` / `.git/AUTO_MERGE` are identical to their pre-probe values

#### Scenario: Worktree state is unchanged after a conflicting probe

- **WHEN** the check-merge executor runs a probe whose outcome is failure (the merge would conflict)
- **THEN** the same byte-for-byte invariants hold on the worktree; no merge artifacts persist in `.git/`, no files are staged, no working-tree changes are introduced

#### Scenario: Probe runs in the node's resolved cwd

- **WHEN** the check-merge executor is invoked with `ctx.cwd` set to a worktree path different from the process's `cwd`
- **THEN** the underlying git invocations are scoped to `ctx.cwd` and do not consult any other repository

### Requirement: Check-merge executor outcomes by mode

Under `mode: "any-merge"` (the default), the executor SHALL emit a final `status: "succeeded"` event when the merge would auto-resolve cleanly — whether via fast-forward (the base is an ancestor of HEAD or vice versa) or via a merge commit with no conflicting hunks. The executor SHALL emit a final `status: "failed"` event when the merge would produce one or more conflicts that auto-merge cannot resolve.

Under `mode: "fast-forward"`, the executor SHALL emit `status: "succeeded"` only when the base is an ancestor of HEAD (the merge would be a fast-forward, with no merge commit required). The executor SHALL emit `status: "failed"` when a merge commit would be required, even if the auto-merge under that mode would have been conflict-free. The executor SHALL also emit `status: "failed"` when the merge would conflict (the same condition as `any-merge`'s failure).

In both modes, the `failed` status event's message SHALL name the failure shape — "conflicts at <count> path(s)" / "merge commit required under fast-forward mode" / "no merge base" — so the operator can diagnose without re-running.

#### Scenario: Fast-forward merge succeeds under any-merge

- **WHEN** the executor probes a worktree whose `HEAD` is reachable from `base` by linear advance (no divergent commits) with `mode: "any-merge"`
- **THEN** the executor emits `status: "succeeded"`

#### Scenario: Clean merge-commit merge succeeds under any-merge

- **WHEN** the executor probes a worktree whose `HEAD` and `base` have diverged but every changed file's hunks can auto-merge cleanly, with `mode: "any-merge"`
- **THEN** the executor emits `status: "succeeded"`

#### Scenario: Clean merge-commit merge fails under fast-forward

- **WHEN** the executor probes the same divergent-but-cleanly-mergeable worktree as above, with `mode: "fast-forward"`
- **THEN** the executor emits `status: "failed"` and its message names "merge commit required" (or equivalent) as the cause

#### Scenario: Conflicting merge fails under any-merge

- **WHEN** the executor probes a worktree where at least one file's hunks conflict between `HEAD` and `base`, with `mode: "any-merge"`
- **THEN** the executor emits `status: "failed"` and its message names the conflict-count or conflicting paths

#### Scenario: Conflicting merge fails under fast-forward

- **WHEN** the executor probes a conflicting worktree with `mode: "fast-forward"`
- **THEN** the executor emits `status: "failed"` (the conflict path supersedes the merge-commit path)

#### Scenario: Missing base branch fails

- **WHEN** the executor probes a worktree against a `base` value naming a branch (or ref) that does not exist
- **THEN** the executor emits `status: "failed"` whose message names the missing base value

### Requirement: Bundled `check-merge` step file

The repository SHALL ship a built-in step file at `examples/steps/check-merge.yaml` that conforms to the `step-schema` capability and declares:

- `name: check-merge`
- `version`: a non-empty SemVer-shaped string
- `description`: a single-paragraph human-readable summary
- `executor: check-merge`
- `inputs`:
  - `base`: `{ type: "string", required: false, default: "{{ run.base_branch }}" }`
  - `mode`: `{ type: "string", required: false, default: "any-merge" }`
- `with`:
  - `base: "{{ inputs.base }}"`
  - `mode: "{{ inputs.mode }}"`

The step file SHALL declare no other top-level keys (`name`, `version`, `description`, `inputs`, `executor`, `with` exhaust the documented set per the `step-schema` capability's "Step file format" requirement).

A node that declares `uses: minifac:check-merge` and no `inputs:` block SHALL resolve to a node whose `with.base` is the literal token `"{{ run.base_branch }}"` (to be resolved by the runner at dispatch time) and whose `with.mode` is the literal string `"any-merge"`.

#### Scenario: Step file parses cleanly

- **WHEN** `loadStep("<package-root>/examples/steps/check-merge.yaml")` is invoked
- **THEN** the loader returns a typed step object with `executor === "check-merge"`, `inputs.base.type === "string"` (with a default), `inputs.mode.type === "string"` (with `default === "any-merge"`), and `inputs.mode.required === false`

#### Scenario: Reference resolves via the built-in lookup

- **WHEN** the step resolver is asked to resolve `minifac:check-merge` and the bundled-built-ins path has the file (or the source-tree fallback resolves it)
- **THEN** the resolver returns the absolute path to `examples/steps/check-merge.yaml`

#### Scenario: Defaulted node yields run-base-branch token in resolved with

- **WHEN** a factory node declares `uses: minifac:check-merge` with no `inputs:` block, and the loader resolves the factory
- **THEN** the resolved node's `with.base === "{{ run.base_branch }}"` and `with.mode === "any-merge"`, with no `uses` or `inputs` field remaining on the node

#### Scenario: Override via inputs threads through

- **WHEN** a factory node declares `uses: minifac:check-merge` with `inputs: { base: "develop", mode: "fast-forward" }`
- **THEN** the resolved node's `with.base === "develop"` and `with.mode === "fast-forward"`

