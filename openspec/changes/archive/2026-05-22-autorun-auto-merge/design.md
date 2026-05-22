## Context

`runFactory` (`src/runner/run.ts`) calls `markBriefDone`
unconditionally on terminal-success at ~line 494. That call moves
`inputs/<change>.md` to `inputs/done/<change>.md` inside the
worktree, and commits the move. The autorun scheduler reads the
brief's doneness from the on-disk location of the file (per
`brief-state` "Brief doneness derivation"), so the move is what
flips a brief from `active` to `done`. Dependents whose
`depends_on` lists that change become eligible to schedule.

`runMerge` (`src/cli/merge.ts`) is the existing merge primitive.
It resolves a change (or a run-id prefix) to a `StoredRun` row,
verifies the working tree of the *caller's repo* is clean,
checks out the default branch, attempts `git merge --ff-only
<branch>`, falls back to `git merge --no-ff` unless `--ff-only`
was supplied, and on conflict runs `git merge --abort` to leave a
clean tree. It writes a one-line success summary on stdout and
returns 0; it returns 1 with stderr text on any failure.

Autorun (`src/cli/autorun.ts`) is a poll loop that shells out to
the run primitive for each ready brief. It tracks in-flight runs,
emits structured events (`AutorunEvent` union), and exposes both
raw and TUI output modes. The TUI consumes the same event stream
plus per-run node events.

The interaction we need: in the autorun success path, fold a
merge step between "factory succeeded" and "brief marked done".
Closing the gap requires three coordinated changes:

1. Autorun's wrapper invokes `runMerge` after the factory's
   terminal-success, before the brief is moved to `inputs/done/`.
2. The runner's mark-done post-step is suppressed for that path
   so the autorun wrapper owns the move (otherwise the runner
   moves the brief first and a later merge failure can't undo
   it without committing more state).
3. `minifac merge` is taught to call mark-done on success so the
   operator's manual recovery actually unblocks dependents.

## Goals / Non-Goals

**Goals**

- A successful autorun chain (A → B with `B.depends_on: [A]`)
  results in B's worktree containing A's commits, because A was
  merged onto the base branch before B was scheduled.
- A failed merge in autorun is visible to the operator as a
  distinct signal (TUI glyph, log event), not buried.
- The runs row stays `succeeded` when the factory succeeded;
  the merge outcome is a separate signal carried by the new
  event, not by downgrading the run status. This preserves
  the existing semantics that "succeeded" means "the factory
  reached a terminal-success node".
- Operators can opt out cleanly (`--no-auto-merge`) and get
  exactly today's behavior — same events, same exit codes,
  same mark-done timing, no merge attempted.
- The recovery path is operator-driven and complete:
  `minifac merge <change>` finishes the loop by moving the
  brief to done.
- `runMerge` is reused. No duplicated git plumbing.

**Non-Goals (v0)**

- Auto-merge in manual `minifac run`. Out of scope by design;
  manual users keep their two-step flow.
- Push to remote. Autorun is local.
- Cycle-on-conflict edges. Captured in
  `docs/Open-Questions.md`; gated on node-outputs.
- Treating a merge failure as a *factory* failure. The factory
  succeeded; the merge step is a wrapper-level action. The runs
  row stays `succeeded`.
- Auto-resolving merge conflicts (cherry-pick, rebase). Out of
  scope; conflict aborts and surfaces.
- Mergeability *probe*. Already shipped as
  `minifac:check-merge`; this change is about the *action*.

## Decisions

### Decision: Auto-merge step lives in the autorun wrapper, not in `runFactory`

The brief is explicit: the auto-merge step fires only in
`autorun`'s success handler, not in `runner/run.ts`'s general
success path. The reason is blast-radius control. `runFactory` is
called both by `minifac run` (manual, one-shot) and by autorun
(unattended chains). Manual users today expect the two-step flow
(run then merge); adding an auto-merge to the general success
path would surprise them. By placing the merge step in the
autorun wrapper specifically, we keep the surprise scoped to the
caller that asked for unattended chaining.

This also keeps `runFactory`'s contract narrow: factory
orchestration, event emission, mark-done. Merging is a
repo-level operation against the caller's repo, not a worktree
operation; it doesn't belong in the inner loop.

**Rejected alternative.** Put the merge step inside
`runFactory` and add a `noAutoMerge: true` opt-out everywhere
the manual path calls it. Increases the number of options
threaded through and risks the manual user forgetting to set
the opt-out in some new caller. The "scope it to the autorun
wrapper" framing is the safer default.

### Decision: Runner mark-done is suppressed via an explicit caller option

For the ordering invariant (`factory success → merge →
mark-done`) to hold, the runner's mark-done post-step CANNOT
fire before the merge. Two designs:

A) Add `suppressMarkDone: boolean` to `RunOptions` /
   `runFactory`. Autorun sets it; manual run does not.
   `runFactory` skips the mark-done call when the flag is true.
   Autorun calls `markBriefDone` itself after a successful
   merge.

B) Remove the mark-done call from `runFactory` entirely and
   move it to every caller (manual run + autorun). Cleaner in
   principle, but the manual path currently has no place to
   call it (the runner exits and the CLI prints the result;
   there's no "post-run" handler at the manual caller).

We pick (A). The suppression option is local to autorun's
wrapper; manual run keeps today's behavior with zero diff.
The `brief-state` "Runner marks brief done after
terminal-success" requirement is modified to declare the
option and its meaning, so the contract stays visible.

**Rejected alternative.** Have autorun do the merge *first* and
let mark-done fire on success only by polling the worktree
state. Convoluted and breaks the "mark-done is a runner
contract" framing.

### Decision: Failure surfacing via a new event kind, not a status downgrade

When the merge fails, two things are true:

- The factory succeeded. The runs row's `status` is `succeeded`
  and `proximate_node_id` points at the terminal node. The
  work is done; the only thing left is to land it on the base.
- The branch is not on the base. Dependents must not unblock.

If we downgraded the runs row to `failed` we'd be lying about
the factory work and would also trip the "failed run → journal"
machinery that lives in `worktree-management`. We don't want
either. So we leave the runs row alone and surface the merge
outcome via a new autorun event kind `auto-merge-failed`.

That event is consumed by:

- The raw logger (human + JSON) — same format pattern as
  existing autorun events.
- The TUI reducer — drives the new `succeeded-but-unmerged`
  brief status.

The event SHALL carry a `reason` enum:

- `conflict` — `runMerge` aborted a merge-commit fallback on
  conflict and listed conflicting paths.
- `non-fast-forward` — under `--ff-only`, the FF attempt
  failed and the fallback is forbidden.
- `dirty-working-tree` — the caller's repo had uncommitted
  changes (rare under autorun but possible).
- `no-default-branch` — `runMerge` could not resolve a
  default branch (no `default_branch` config, no
  `origin/HEAD`, no local `main`).
- `null-branch-name` — the resolved run row's `branchName`
  was null (pre-migration row).
- `other` — any non-zero exit not covered above; the message
  carries the underlying stderr.

Two reasons exist for the enum vs free-text: log lines stay
greppable, and the TUI can color or label distinctly later.

**Rejected alternative.** Emit `completed status=failed` for
the merge failure. Conflates the factory outcome with the
merge outcome and breaks the `auto-mode` "Per-run failure does
not crash autorun" scenario contract (which says `completed
status=failed` is a factory-level failure).

### Decision: `--no-auto-merge` is the documented opt-out; default is opt-in

The brief asks for `--no-auto-merge` to "restore today's
behavior exactly". To honor that, when the flag is set:

- No merge step runs.
- The runner's mark-done post-step is NOT suppressed (the
  runner moves the brief on factory success exactly as it
  does today).
- No `auto-merge-failed` events fire.
- Today's autorun scenarios pass verbatim (a regression test
  exercises this directly).

Auto-merge being the default (opt-in) is consistent with the
brief's framing — the autorun chain story is broken without it,
and operators who want the old behavior can ask for it.

**Rejected alternative.** Default to off, require
`--auto-merge` to opt in. Pushes the broken-chain problem onto
every chain author by default. Rejected.

### Decision: `--ff-only` mirrors `minifac merge --ff-only`

Autorun's `--ff-only` flag SHALL be forwarded to `runMerge` as
its `ffOnly` option. The semantics are unchanged: a
non-fast-forward merge attempt becomes a merge failure rather
than falling back to a merge commit. Under autorun, that
failure becomes an `auto-merge-failed reason=non-fast-forward`
event.

Default is *not* `--ff-only`. The brief's user preference
(documented at the top of the brief: "Default = fast-forward
with merge-commit fallback (matches the user preference)")
chooses the lenient path; chains that demand linear history
opt in.

**Rejected alternative.** Default `--ff-only`. Trips chains on
every concurrent merge and yields false-positive
`auto-merge-failed` events.

### Decision: `--no-auto-merge` and `--ff-only` together: not a usage error

Two flags that are logically inconsistent but harmless together:
`--no-auto-merge` makes the merge step a no-op, so `--ff-only`
has no effect. We resolve to "warn but accept" rather than
"reject as usage error" because operators may flip
`--no-auto-merge` on temporarily without remembering to drop
`--ff-only`. A usage error there would be hostile.

The autorun CLI SHALL emit a single startup-time stderr line:
"--ff-only has no effect when --no-auto-merge is supplied".
Exit 0; continue.

**Rejected alternative.** Reject as usage error. Hostile for
the recovery scenario.

### Decision: `minifac merge` calls mark-done on success — but only on the change-by-name path

The brief asks for `minifac merge <change>` to call
`markBriefDone` on success. The change-by-name path resolves a
brief unambiguously: if you said "merge change foo", you
intended "land foo", and "foo is done" follows. So mark-done
fires.

The run-id-prefix path (`minifac merge a7b3c1`) is different.
The operator may be merging a non-latest run for the change
(e.g. cherry-picking a previous attempt), or merging a run
whose brief is *already* in `inputs/done/` (idempotent — no-op),
or merging a run whose change file is *not* present anymore
(brief was deleted/renamed). Calling mark-done from the
id-prefix path could surprise an operator who explicitly named
a single run. So:

- Change-by-name (`runMerge` resolved by `arg` = change name):
  call mark-done on success.
- Id-prefix (`runMerge` resolved by hex-prefix matching a
  run id): do NOT call mark-done.

`runMerge` already knows which resolution path succeeded;
plumbing the resolved row's `change` and the resolution path
into the post-step is a small refactor of the resolver.

The mark-done helper is idempotent (per `brief-state` "Brief
already in inputs/done/ is an idempotent skip" scenario), so
calling it after a `minifac merge foo` whose brief was already
moved (operator ran `minifac merge` redundantly) is safe — no
error, no warning, no commit.

**Rejected alternative.** Always call mark-done from
`minifac merge` regardless of resolution path. Surprises the
operator in the cherry-pick scenario.

### Decision: TUI brief status `succeeded-but-unmerged`

The autorun TUI's brief-list pane currently renders five
statuses (`queued`, `running`, `succeeded`, `failed`,
`skipped`) per `autorun-tui` "Brief status glyphs". We add a
sixth: `succeeded-but-unmerged`.

Glyph: `◐` (Unicode) / `*` (ASCII). The half-filled circle
reads as "almost done" against the filled `●` for
`succeeded`. Color: yellow (warning) — distinct from green
(`succeeded`) and red (`failed`).

Reducer transition: a brief in `running` that receives the
sequence (`completed status=succeeded`, then
`auto-merge-failed`) for the same `change` transitions to
`succeeded-but-unmerged`. A subsequent reset (rare; the
brief would need to re-enter the autorun candidate set,
which happens when the operator runs `minifac merge` and a
new poll observes the brief at `inputs/done/`) flips it out
of the state via the normal "brief is done" reducer rules.

The TUI does not itself observe mark-done — it observes
events. The "operator runs `minifac merge` and the brief
moves to done" path leaves the TUI's
`succeeded-but-unmerged` row in place until either (a) the
TUI is restarted (next poll, fresh state), or (b) we later
add a "brief moved to done" event. (b) is out of scope for
v0; the operator who runs `minifac merge` is in a different
terminal anyway.

**Rejected alternative.** Reuse the `failed` glyph. Misleads
the operator into thinking the factory failed when in fact
only the merge did.

**Rejected alternative.** Add a separate "merging" status
between `succeeded` and `succeeded-but-unmerged`. The merge
step is fast enough that animating an intermediate state
adds noise without value.

### Decision: Reuse `runMerge`, do not write a new merge primitive

The brief is explicit. `runMerge`'s entire surface (resolution,
default-branch detection, dirty-tree refusal, FF + fallback,
conflict-abort) is exactly what we want; the only differences
are (a) input — we have a concrete run row in hand from
autorun's just-completed run, not a CLI argument — and (b)
output — we want a structured outcome (success / reason), not
exit codes and stderr.

We will extract a small `mergeRun(row: StoredRun, opts)`
helper that takes the resolved row directly and returns a
structured outcome. `runMerge` becomes a thin CLI wrapper that
resolves and then delegates. Autorun's success handler calls
`mergeRun` with the in-hand row.

The structured outcome:

```ts
type MergeOutcome =
  | { ok: true; headSha: string }
  | { ok: false; reason: AutoMergeFailReason; message: string };
```

`AutoMergeFailReason` matches the event-kind enum above.
`runMerge` maps the outcome to its existing stdout/stderr
contract; autorun maps it to the `auto-merge-failed` event.

**Rejected alternative.** Shell out to `git` directly from
autorun. Duplicates plumbing and drifts.

### Decision: Suppression option is named `skipMarkDone`, not `noMarkDone`

Minor naming choice. The runner's option is a *behavior*
modifier ("skip the mark-done step this run"), and we already
use `skip-*` prefixes for related flags. `noMarkDone` reads
like a negated default, which it isn't — mark-done IS the
default; this option is the override.

## Risks / Trade-offs

- **Risk: A merge step under autorun changes the timing of
  side effects.** Today, a successful factory run produces a
  commit on the worktree (mark-done) and the operator later
  produces a commit on the base (merge). Under auto-merge, both
  commits happen back-to-back; if the operator was relying on
  a window between them (e.g. inspecting the worktree before
  the merge lands), the window vanishes. → Mitigation:
  `--no-auto-merge` is the documented opt-out, preserving the
  pre-merge inspection window for operators who need it.
- **Risk: Merge runs against the caller's repo, not a
  worktree.** The dirty-working-tree refusal in `runMerge`
  becomes more important under autorun; an autorun session that
  starts with a dirty repo (uncommitted changes the operator
  left) will see every auto-merge fail with
  `dirty-working-tree`. → Mitigation: the event is grepable
  and the TUI shows the status; an operator who sees a wave
  of `dirty-working-tree` events knows to stash. Future:
  emit a single startup-time warning when the caller's repo is
  dirty at autorun launch.
- **Risk: Cross-change concurrency under
  `--max-concurrent N > 1` could race on the merge step.**
  Two autorun-scheduled runs that complete near-simultaneously
  both try to check out the default branch in the caller's
  repo, leading to ordering issues. → Mitigation: serialize the
  merge step inside the autorun wrapper (a single in-process
  mutex around `mergeRun`). The merge is fast (<1s typical);
  serializing across concurrent runs is fine. The mutex is
  scoped to autorun's process; cross-process collisions remain
  the operator's problem (same as today).
- **Risk: The `auto-merge-failed` event introduces a new
  event kind that downstream JSON consumers may not expect.**
  → Mitigation: the JSON contract is additive; consumers that
  ignore unknown event kinds keep working. We do NOT remove
  any existing event kinds.
- **Risk: An operator-initiated `minifac merge` calling
  mark-done could surprise someone who used `minifac merge` to
  test a merge sequence without intending to land the brief.**
  → Mitigation: the change-by-name path is "I intend to land
  this change"; the id-prefix path is "I'm merging a specific
  run" and does NOT call mark-done. The naming convention is
  loud enough that the surprise window is narrow.
- **Trade-off: `runFactory` gains a `skipMarkDone` option.**
  We accept the option; it's small, well-scoped, and the
  alternative (moving mark-done out of `runFactory` entirely)
  has more blast radius.
- **Trade-off: The autorun success path now has an additional
  point of failure (the merge step) on the happy path.** Yes
  — that's the whole point. The alternative is silently broken
  chains.

## Migration Plan

1. Land the `skipMarkDone` option on `RunOptions` /
   `runFactory`. Default false. Manual run callers unchanged.
   Add a unit test that the suppression option suppresses the
   mark-done call.
2. Extract `mergeRun(row, opts)` from `runMerge`. `runMerge`
   becomes a thin wrapper. All existing `minifac merge` tests
   pass unchanged.
3. Add the `auto-merge-failed` event kind to `AutorunEvent`,
   its human/JSON formatters, and the reducer transition.
   Add the `succeeded-but-unmerged` brief status to the TUI
   glyph table.
4. Wire the auto-merge step into the autorun completion
   handler. Add the `--no-auto-merge` and `--ff-only` flags;
   propagate them through `AutorunOptions`. Update the autorun
   help text.
5. Teach `runMerge` to call mark-done on the change-by-name
   success path. Thread the resolution-path signal through
   `runMerge` so the post-step fires only when appropriate.
6. Run the test suite; iterate.
7. Manually exercise the chain integration test: create two
   briefs in `inputs/`, B depends on A; run
   `minifac autorun --once --max-concurrent 1`; confirm A's
   commits are on the base when B starts; confirm B's worktree
   includes them.
8. No rollback step needed — the change is additive. Reverting
   the `--no-auto-merge` default to on (i.e. making the merge
   step opt-in) is a one-line change; reverting the whole
   subsystem is reverting the autorun wrapper diff plus the
   event reducer / TUI delta.

## Open Questions

- Should the auto-merge step block on a `check-merge` probe
  failure inside the factory? Today, a factory that wires
  `minifac:check-merge` as terminal and fails it leaves the
  factory in a `failed` state, which short-circuits the
  auto-merge step entirely (autorun's auto-merge only fires
  on factory success). So the two compose correctly without
  explicit coordination. Documented in the proposal; no
  contract change needed.
- Should `auto-merge-failed` carry a structured diff /
  conflict path list as a payload? Same node-outputs
  dependency as the cycle-on-conflict story. Defer.
- Should the autorun startup-time warning for a dirty caller
  repo land in this change? Useful but tangential; defer to
  a follow-on if the failure mode is common in practice.
- Should `minifac merge` gain a `--no-mark-done` flag for
  operators who explicitly want the change-by-name path
  WITHOUT the post-step? Cheap to add, but no concrete user
  ask yet. Defer.
- Whether the cross-run merge mutex should be a real mutex
  or a queue. A mutex is simpler and the merge step is fast.
  Pick the mutex; revisit if it bites.
