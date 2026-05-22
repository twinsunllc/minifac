## Why

`minifac autorun` does not merge a successful run's branch into the
default branch. The runner's mark-done post-step (per the
`brief-state` capability's "Runner marks brief done after
terminal-success" requirement) moves `inputs/<change>.md` to
`inputs/done/<change>.md` as soon as the factory reaches a
terminal-success node. In an autorun chain where brief B
`depends_on` A, that is enough for the scheduler to consider A
"done" and unblock B (per `auto-mode` "Autorun poll loop") —
but A's branch has not been merged into the configured base
yet. B's worktree gets created off the base branch without A's
code, and B's run silently builds on the wrong baseline.

The [[check-merge-step]] change added a read-only mergeability
probe. It tells a factory whether the merge *would* succeed; it
does not actually merge. The operator-facing action lives in
`minifac merge` (`src/cli/merge.ts`, exported as `runMerge`).
Autorun chains need that action to fire automatically in the
success path so the "done" signal a dependent observes implies
"on the base branch", not just "factory finished".

A natural fix is to invoke `runMerge` inside autorun's success
handler before mark-done, gate mark-done on a successful merge,
and surface merge failures as a distinct event so the operator
can intervene. The runner's existing two-step manual flow stays
unchanged (`minifac run` followed by `minifac merge`); the
auto-merge step lives in `autorun`'s wrapper, not in
`runFactory`.

## What Changes

- **Autorun success path merges before marking done.** When a
  scheduled run terminates `succeeded`, the autorun process
  SHALL invoke `runMerge` against the run's branch and the
  caller's configured default branch BEFORE marking the brief
  done. The runner's built-in mark-done post-step (per
  `brief-state` "Runner marks brief done after terminal-success")
  SHALL be suppressed for autorun-scheduled runs whose auto-merge
  step is enabled; autorun owns the mark-done call so it can
  gate it on the merge result.
- **Ordering invariant: factory success → merge → mark-done.** If
  the merge fails (conflict, non-fast-forward under `--ff-only`,
  dirty default branch, refused resolution), autorun SHALL NOT
  invoke mark-done. The brief SHALL stay at `inputs/<change>.md`
  so dependents stay blocked. The runs row SHALL persist as
  `succeeded` (the factory work itself succeeded); the merge
  failure is a separate signal carried by a new event kind.
- **New `auto-merge-failed` autorun event.** Autorun's structured
  log stream (per `auto-mode` "Autorun structured logging") gains
  a new event kind `auto-merge-failed`. The event carries
  `change`, optional `runId`, and `reason` (a short human-
  readable cause: `conflict`, `non-fast-forward`,
  `dirty-working-tree`, `no-default-branch`, `null-branch-name`,
  or `other`). The raw mode emits it as a human-readable line by
  default and as a single-line JSON object under `--json`. The
  TUI consumes it via its existing reducer.
- **`minifac autorun --no-auto-merge` opts out.** Restores
  today's behavior exactly: no merge call, the runner's mark-done
  post-step is NOT suppressed, the brief moves to `inputs/done/`
  unconditionally on factory success. No new event types fire.
  This flag is the documented escape hatch for operators who
  want to keep the two-step flow under autorun.
- **`minifac autorun --ff-only` forbids the merge-commit
  fallback.** Same meaning as `minifac merge --ff-only`: a
  non-fast-forward merge is a merge failure under this flag.
  Mutually compatible with `--no-auto-merge` only in the sense
  that `--no-auto-merge` wins (it suppresses the merge entirely,
  so `--ff-only` becomes a no-op when both are supplied —
  warning only, not a usage error).
- **New autorun TUI brief status `succeeded-but-unmerged`.**
  The `autorun-tui` capability's "Brief status glyphs"
  requirement gains a fifth brief status alongside `queued`,
  `running`, `succeeded`, `failed`, `skipped`. A brief whose
  most recent run succeeded but whose autorun-driven auto-merge
  failed SHALL render with a distinct glyph and color so the
  operator sees at a glance that the run completed but the
  branch is not on the base. The reducer SHALL transition a
  brief from `running` to `succeeded-but-unmerged` when it
  receives an `auto-merge-failed` event after the corresponding
  `completed status=succeeded` event for the same `change`.
- **`minifac merge <change>` calls mark-done on success.** The
  `runMerge` function (or its CLI wrapper) SHALL, on a
  successful merge resolved by change name (not by raw run id),
  invoke the same mark-done helper the runner uses, so the
  recovery path actually moves the brief to `inputs/done/` and
  unblocks dependents on the next autorun poll. The mark-done
  helper is idempotent (per `brief-state` "Brief already in
  inputs/done/ is an idempotent skip" scenario), so the new
  call is a no-op when the brief was already moved (the
  `--no-auto-merge` path, or a manual `minifac run` followed by
  `minifac merge`).
- **Reuse `runMerge` from autorun.** The actual merge work
  invoked from autorun SHALL reuse `runMerge` so the merge
  semantics, error messages, and edge cases (dirty tree,
  null `branchName`, no default branch, conflict-then-abort)
  stay shared between the manual and automatic paths.

## Capabilities

### New Capabilities

None. The change adds requirements to existing capabilities
(`auto-mode`, `run-cli`, `autorun-tui`, `brief-state`) rather
than introducing a new one. The auto-merge step is a behavior
of the autorun loop, not a separable subsystem.

### Modified Capabilities

- `auto-mode`: ADDS a requirement defining the auto-merge step
  inside the autorun success path: ordering (factory success →
  merge → mark-done), suppression of the runner's mark-done
  post-step, `auto-merge-failed` event semantics, and the
  `--no-auto-merge` / `--ff-only` flag effects on the loop.
- `run-cli`: MODIFIES the `minifac autorun` subcommand
  requirement to declare the `--no-auto-merge` and `--ff-only`
  flags (defaults, types, interaction with other flags).
  MODIFIES the `minifac merge` subcommand requirement to
  declare that a successful merge resolved by change name
  invokes the mark-done helper.
- `autorun-tui`: MODIFIES the "Brief-list event reducer" and
  "Brief status glyphs" requirements to add the
  `succeeded-but-unmerged` brief status, its glyph and color,
  and the reducer transition triggered by the new
  `auto-merge-failed` event.
- `brief-state`: MODIFIES the "Runner marks brief done after
  terminal-success" requirement to declare a caller-supplied
  suppression option (used by autorun when auto-merge is
  enabled) so the runner does NOT mark done in that path;
  autorun calls mark-done itself after a successful merge.

## Impact

- **New code.** A small auto-merge step inside the autorun
  wrapper (`src/cli/autorun.ts` or a sibling module) that
  invokes `runMerge` against the completed run, emits the new
  event on failure, and calls the mark-done helper on success.
  A new `AutorunEvent` variant `auto-merge-failed` with its
  human-readable and JSON renderers.
- **Modified code.**
  - `src/cli/autorun.ts`: the completion handler grows the
    merge step; the option type grows `noAutoMerge: boolean`
    and `ffOnly: boolean`; the event union grows
    `auto-merge-failed`; the logger formats it.
  - `src/cli/merge.ts`: `runMerge` (or its caller in `cli.ts`)
    invokes the mark-done helper on success when the
    resolution path was change-by-name. Pure run-id-prefix
    merges retain today's behavior (no mark-done) because the
    operator may be cherry-picking a non-latest run and a
    mark-done would be surprising.
  - `src/cli.ts`: the `autorun` command wires the two new
    flags into `AutorunOptions`; the `merge` command threads
    the resolved change name into `runMerge` so the post-step
    can fire.
  - `src/runner/run.ts`: the existing mark-done block at
    ~line 494 grows a `suppressMarkDone` opt-in honored by
    the caller; `runFactory`'s options type grows the field.
    Manual `minifac run` continues to call without the flag,
    so its behavior is unchanged.
  - `src/tui/autorun-reducer.ts`: a new brief status
    `succeeded-but-unmerged`; the reducer handles the new
    event kind; tests cover the transitions.
  - The autorun TUI glyph table (in the brief-list pane)
    gains a row for the new status.
- **Tests.**
  - Unit: autorun success path invokes the merge step;
    success continues to mark-done; failure suppresses
    mark-done and emits `auto-merge-failed`; `--no-auto-merge`
    skips the merge and preserves today's mark-done path;
    `--ff-only` rejects a non-fast-forward merge and emits
    `auto-merge-failed reason=non-fast-forward`.
  - Unit: `minifac merge foo` (change-by-name path) calls
    the mark-done helper after a successful merge;
    `minifac merge <run-id>` does NOT call it (id-prefix
    path is opt-out by construction).
  - Reducer: an `auto-merge-failed` event after a
    `completed status=succeeded` transitions the brief to
    `succeeded-but-unmerged`; a subsequent operator
    `minifac merge` (observed via a hypothetical re-poll
    that sees the brief moved to done) is out of scope for
    the reducer's in-process state but documented.
  - Integration: a 2-brief chain where B `depends_on` A
    runs under `minifac autorun --once --max-concurrent 1`;
    after A completes the auto-merge succeeds, B's worktree
    is created off the base branch and contains A's commits.
  - Integration: the operator-recovery path — A's
    auto-merge fails (seeded by a pre-existing divergent
    commit on the default branch), the operator runs
    `minifac merge A` by hand, A's brief moves to
    `inputs/done/`, and the next autorun poll unblocks B.
  - Build: `npm run build` is clean.
- **Documentation.**
  - `docs/concepts/Run.md` (or wherever the autorun success
    path is documented) gains a paragraph naming the
    auto-merge step and the ordering invariant.
  - `docs/concepts/Brief.md` notes that "done" under autorun
    implies "merged onto the base branch", not just
    "factory finished".
  - The `minifac autorun --help` output documents the two
    new flags.
- **Out of scope** (filed elsewhere or rejected):
  - Mergeability *probe* as a workflow node — already
    shipped as `minifac:check-merge` via [[check-merge-step]].
  - Running dependents against the predecessor's branch on
    merge failure. Considered and rejected; halt-on-failure
    is the safe default for unattended sessions.
  - Auto-merge in manual `minifac run`. Out of scope to
    preserve the two-step manual flow.
  - Cycle-on-conflict edge semantics (`on_merge_conflict`
    routing back to `apply`). Filed in
    `docs/Open-Questions.md`; gated on node-outputs.
  - Pushing the merged branch to a remote. Autorun is local;
    remote push remains an operator concern.
