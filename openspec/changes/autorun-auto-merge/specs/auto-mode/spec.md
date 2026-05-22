## ADDED Requirements

### Requirement: Autorun auto-merge step on factory success

The autorun process SHALL, when a scheduled run terminates with
the runs-row status `succeeded` and auto-merge is enabled (the
default; opt-out is the `--no-auto-merge` flag per the
"Autorun auto-merge flags" requirement below), invoke the merge
primitive against the run's branch and the caller's configured
default branch BEFORE invoking the mark-done helper. The merge
primitive SHALL be the same primitive that backs
`minifac merge` (per the `run-cli` capability's "`minifac
merge` subcommand" requirement) so that resolution rules,
default-branch detection, dirty-tree refusal, fast-forward
attempt, merge-commit fallback, and conflict-abort behave
identically.

The ordering invariant SHALL be:

1. Factory reaches a terminal-success node; the runs row is
   recorded as `succeeded`.
2. The autorun wrapper invokes the merge primitive against
   the run's branch.
3. If the merge succeeds, the autorun wrapper invokes the
   mark-done helper (per the `brief-state` capability's
   "Runner marks brief done after terminal-success"
   requirement) so the brief moves from `inputs/<change>.md`
   to `inputs/done/<change>.md`.
4. If the merge fails, the autorun wrapper SHALL NOT invoke
   the mark-done helper; the brief SHALL stay at
   `inputs/<change>.md`, and dependents whose `depends_on`
   includes this change SHALL stay blocked on subsequent
   poll cycles.

The runs row SHALL stay `succeeded` regardless of the merge
outcome. The merge outcome is a separate signal carried by the
`auto-merge-failed` event (see the "Autorun auto-merge-failed
event" requirement below), not by downgrading the runs row.

The autorun wrapper SHALL suppress the runner's built-in
mark-done post-step for any auto-merge-enabled run by passing
the runner the `skipMarkDone` option declared in the
`brief-state` capability's modified "Runner marks brief done
after terminal-success" requirement. The autorun wrapper owns
the mark-done invocation so it can gate it on the merge
outcome.

When multiple concurrent in-flight autorun runs are completing
(per the `auto-mode` capability's existing "Autorun
concurrency cap" requirement), the autorun wrapper SHALL
serialize the merge step across runs via an in-process mutex
so two completions do not race against each other in the
caller's repo (each merge step checks out the default branch
and runs `git merge` against it; concurrent attempts would
collide). The merge step SHALL hold the mutex for the
duration of the merge primitive invocation and SHALL release
it before invoking the mark-done helper.

#### Scenario: Successful factory + successful merge moves brief to done

- **WHEN** the autorun process schedules `foo` (auto-merge
  enabled by default), the factory terminates `succeeded`,
  and the merge primitive returns success against the
  caller's default branch
- **THEN** the autorun wrapper invokes the mark-done helper,
  the brief at `inputs/foo.md` moves to `inputs/done/foo.md`
  in the worktree, the runs row stays `status = succeeded`,
  and the autorun process emits a single `completed
  status=succeeded` event for `foo`

#### Scenario: Successful factory + failed merge keeps brief at inputs

- **WHEN** the autorun process schedules `foo` (auto-merge
  enabled), the factory terminates `succeeded`, and the
  merge primitive returns failure (e.g. conflict)
- **THEN** the autorun wrapper does NOT invoke the mark-done
  helper, the brief at `inputs/foo.md` stays put, the runs
  row is recorded with `status = succeeded`, and the autorun
  process emits both a `completed status=succeeded` event
  AND an `auto-merge-failed` event for `foo`

#### Scenario: Chained briefs see the predecessor's commits after auto-merge

- **WHEN** the autorun process schedules a chain `B
  depends_on A` under `--max-concurrent 1`, A completes
  `succeeded`, A's auto-merge succeeds, and the next poll
  schedules B
- **THEN** B's worktree (created off the caller's default
  branch per the `worktree-management` capability) contains
  A's commits on the configured base; B's run runs against a
  baseline that includes A's changes

#### Scenario: Chained brief stays blocked when predecessor's auto-merge fails

- **WHEN** the autorun process schedules a chain `B
  depends_on A` under `--max-concurrent 1`, A completes
  `succeeded`, and A's auto-merge fails
- **THEN** A's brief stays at `inputs/A.md`, A's brief state
  remains `active` per the `brief-state` capability's
  derivation rules, and B is skipped on every subsequent
  poll with reason `blocked` until the operator resolves
  A's merge by hand

#### Scenario: Concurrent completing runs serialize their merge steps

- **WHEN** two in-flight autorun runs `foo` and `bar`
  complete `succeeded` within the same tick under
  `--max-concurrent 2`
- **THEN** the autorun wrapper holds an in-process mutex
  across the merge step so the two merges run sequentially
  against the caller's repo; both merges complete and both
  briefs move to `inputs/done/`; no `auto-merge-failed`
  event fires for either run unless the underlying merge
  itself failed

### Requirement: Autorun auto-merge-failed event

The autorun process SHALL emit a new structured-log event kind
`auto-merge-failed` whenever the auto-merge step (per the
"Autorun auto-merge step on factory success" requirement
above) fails. The event SHALL carry, at minimum:

- `ts` — ISO-8601 timestamp per the existing structured-
  logging contract.
- `change` — the brief's change slug.
- `runId` — the just-completed run's id (optional only when
  the run primitive failed before producing a run id, which
  is rare in practice for the auto-merge path).
- `reason` — a short enum drawn from the closed set
  `conflict`, `non-fast-forward`, `dirty-working-tree`,
  `no-default-branch`, `null-branch-name`, `other`.
- `detail` — an optional human-readable string carrying the
  underlying error (e.g. the git stderr, or the list of
  conflicting paths).

The reason mapping SHALL be:

- `conflict` — the merge primitive aborted a merge-commit
  attempt because of conflicts; conflicting paths
  (if any were extracted from `git diff --name-only
  --diff-filter=U`) SHALL be included in `detail`.
- `non-fast-forward` — `--ff-only` was supplied and the
  fast-forward attempt failed; the merge primitive refused
  to fall back to a merge commit.
- `dirty-working-tree` — the merge primitive refused to
  proceed because the caller's repo had uncommitted
  changes; `detail` SHALL surface the dirty-state message.
- `no-default-branch` — the merge primitive could not
  resolve a default branch (no `default_branch` config,
  no `origin/HEAD`, no local `main`).
- `null-branch-name` — the resolved runs row had a null
  `branchName` (pre-migration row).
- `other` — any non-zero merge-primitive exit not covered
  above; `detail` SHALL carry the underlying stderr.

The event SHALL be emitted AFTER the corresponding
`completed status=succeeded` event for the same `change`,
so consumers (raw logger, TUI reducer) can observe the
factory outcome first and then the merge outcome. The
ordering is required because the TUI reducer's transition to
`succeeded-but-unmerged` depends on observing both events
in that order (per the `autorun-tui` capability's modified
"Brief-list event reducer" requirement).

The event SHALL appear in both output modes (raw and TUI)
the same way every other autorun event does:

- Default human-readable line: `<ts> auto-merge-failed
  <change> reason=<reason>[ runId=<id>][ detail=<detail>]`.
- `--json` mode: a single-line JSON object with `event:
  "auto-merge-failed"`, plus the fields above as a flat
  object.

The `auto-merge-failed` event kind SHALL NOT be emitted when
`--no-auto-merge` is in effect (the merge step does not
run, so no failure can occur).

#### Scenario: Conflict produces auto-merge-failed reason=conflict

- **WHEN** the autorun process completes `foo`'s factory
  `succeeded`, the merge primitive attempts the merge
  fallback path, the merge produces conflicts, and the
  primitive aborts with the conflict paths
- **THEN** the autorun process emits an
  `auto-merge-failed` event with `change = "foo"`,
  `reason = "conflict"`, and a `detail` carrying the
  conflicting paths

#### Scenario: --ff-only refusal produces reason=non-fast-forward

- **WHEN** the user invoked `minifac autorun --ff-only`,
  a run completes `succeeded`, the fast-forward attempt
  fails, and the primitive refuses the merge-commit
  fallback
- **THEN** the autorun process emits an
  `auto-merge-failed` event with `reason =
  "non-fast-forward"` and a `detail` carrying the git
  stderr

#### Scenario: Dirty caller repo produces reason=dirty-working-tree

- **WHEN** the autorun process completes a run while the
  caller's repo has uncommitted changes
- **THEN** the merge primitive refuses, the autorun
  process emits an `auto-merge-failed` event with
  `reason = "dirty-working-tree"`, and the brief stays
  at `inputs/<change>.md`

#### Scenario: --json mode emits auto-merge-failed as JSON

- **WHEN** the user invoked `minifac autorun --json` and
  an auto-merge-failed event fires for `foo`
- **THEN** stdout contains a single JSON object with
  `event === "auto-merge-failed"`, `change === "foo"`,
  a `reason` field, and the standard ISO `ts` field

### Requirement: Autorun auto-merge flags

The autorun process SHALL accept two new flags that govern
the auto-merge step (per the "Autorun auto-merge step on
factory success" requirement above):

- `--no-auto-merge` — opt out of the auto-merge step
  entirely. When supplied, the autorun process SHALL NOT
  invoke the merge primitive on any successful run; the
  runner's built-in mark-done post-step SHALL NOT be
  suppressed (so the runner marks the brief done on
  factory success exactly as it did before this change
  landed); no `auto-merge-failed` event SHALL be emitted.
  This flag is the documented escape hatch that restores
  the pre-auto-merge autorun behavior.
- `--ff-only` — forbid the merge-commit fallback. When
  supplied, the autorun wrapper SHALL invoke the merge
  primitive with its existing `ffOnly` option set true,
  meaning a non-fast-forward merge becomes a merge failure
  (mapped to `auto-merge-failed reason=non-fast-forward`).

The default (neither flag supplied) is: auto-merge enabled,
merge-commit fallback allowed.

Supplying `--no-auto-merge` together with `--ff-only` SHALL
NOT be a usage error. The autorun process SHALL emit a
single startup-time stderr warning line: `--ff-only has no
effect when --no-auto-merge is supplied`, and SHALL
proceed normally (with `--no-auto-merge` winning — the
merge step does not run).

The two flags SHALL appear in the `--json` startup event's
options payload (per the existing startup-event contract)
so JSON consumers can observe how the autorun process was
launched.

#### Scenario: --no-auto-merge preserves today's behavior

- **WHEN** the user invokes `minifac autorun --no-auto-
  merge` against an `inputs/` containing a ready brief
  `foo`, and `foo`'s run completes `succeeded`
- **THEN** the autorun process does NOT invoke the merge
  primitive, the runner's mark-done post-step fires
  exactly as it did before this change landed, the brief
  moves to `inputs/done/foo.md`, no `auto-merge-failed`
  event is emitted, and the runs row records `succeeded`

#### Scenario: --ff-only forbids merge-commit fallback

- **WHEN** the user invokes `minifac autorun --ff-only`,
  a scheduled run completes `succeeded`, and the fast-
  forward attempt against the default branch fails
- **THEN** the merge primitive does NOT fall back to a
  merge commit, an `auto-merge-failed` event fires with
  `reason = "non-fast-forward"`, the brief stays at
  `inputs/<change>.md`, and the runs row remains
  `succeeded`

#### Scenario: --no-auto-merge with --ff-only warns and proceeds

- **WHEN** the user invokes `minifac autorun --no-auto-
  merge --ff-only`
- **THEN** the autorun process writes a single stderr
  warning line `--ff-only has no effect when --no-auto-
  merge is supplied`, mounts (TUI mode) or starts (raw
  mode) the autorun loop as if only `--no-auto-merge`
  were supplied, and exits with the usual exit codes
  (NOT a usage error)
