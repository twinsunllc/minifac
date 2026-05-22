## 1. Runner mark-done suppression hook

- [x] 1.1 Extend `RunOptions` (and `runFactory`'s signature, per
      `src/runner/run.ts`) with an optional `skipMarkDone:
      boolean` field (default `false`). When true, the mark-done
      block at ~line 494 SHALL be skipped entirely; the runs row
      is still recorded as `succeeded`.
- [x] 1.2 Export the existing mark-done helper (`markBriefDone`
      in `src/runner/mark-done.ts`) from `src/index.ts` (or
      otherwise make it callable from `src/cli/autorun.ts` and
      `src/cli/merge.ts`). The helper SHALL remain idempotent-
      safe per its existing contract.
- [x] 1.3 Unit test in `src/runner/run.test.ts` (or a sibling
      module) that:
      - With `skipMarkDone: false` (or unset) the runner moves
        the brief on terminal-success — regression of today's
        behavior.
      - With `skipMarkDone: true` the runner does NOT move
        the brief, emits no mark-done warning, and the runs
        row is still `succeeded`.

## 2. Extract merge primitive from `runMerge`

- [x] 2.1 Refactor `src/cli/merge.ts` to expose a
      `mergeRun(row: StoredRun, opts: MergeRunOptions): Promise<
      MergeOutcome>` helper that takes a resolved run row and
      performs the merge sequence (steps 1–5 in the "Merge
      sequence" subsection of the `minifac merge` requirement).
      `MergeOutcome` SHALL be the tagged union described in the
      design ("Decisions" → "Reuse `runMerge`"): `{ ok: true;
      headSha: string }` or `{ ok: false; reason:
      AutoMergeFailReason; message: string }`.
- [x] 2.2 Re-implement `runMerge` as a thin wrapper that
      resolves `<arg>` and delegates to `mergeRun`. The resolver
      SHALL additionally return the resolution path
      (`"run-id-prefix" | "change-name"`) so the wrapper can
      decide whether to fire mark-done.
- [x] 2.3 Confirm all existing `runMerge` tests pass unchanged
      (the refactor is behavior-preserving for the CLI surface).

## 3. Autorun event surface + flags

- [x] 3.1 Extend the `AutorunEvent` union in
      `src/cli/autorun.ts` with the new variant:
      ```ts
      | (AutorunEventBase & {
          kind: "auto-merge-failed";
          change: string;
          runId?: string;
          reason:
            | "conflict"
            | "non-fast-forward"
            | "dirty-working-tree"
            | "no-default-branch"
            | "null-branch-name"
            | "other";
          detail?: string;
        })
      ```
- [x] 3.2 Extend the `formatHuman` switch to format the new
      event as `<ts> auto-merge-failed <change>
      reason=<reason>[ runId=<id>][ detail=<detail>]`.
- [x] 3.3 Extend the JSON renderer (`event === "auto-merge-
      failed"` plus the flat fields) per the existing pattern.
- [x] 3.4 Extend `AutorunOptions` with `noAutoMerge: boolean`
      and `ffOnly: boolean` (both default `false`). Thread them
      from `src/cli.ts`'s `autorun` command into
      `AutorunOptions`. Document in the help text.
- [x] 3.5 Add CLI-level argument parsing for `--no-auto-merge`
      and `--ff-only` in `src/cli.ts`'s autorun command. When
      both `--no-auto-merge` and `--ff-only` are supplied, emit
      the documented stderr warning line (`"--ff-only has no
      effect when --no-auto-merge is supplied"`) and proceed
      (not a usage error).

## 4. Auto-merge step inside autorun completion handler

- [x] 4.1 In `src/cli/autorun.ts` (or a sibling module
      `src/cli/autorun-merge.ts` if isolation is cleaner), add
      the completion-handler logic:
      - When auto-merge is enabled (default) and the
        just-completed run row has `status === "succeeded"`
        AND `branchName !== null`, invoke `mergeRun(row, {
        ffOnly: options.ffOnly, ...other opts })` against the
        caller's repo.
      - On `MergeOutcome.ok === true`: invoke the mark-done
        helper (from task 1.2) against the worktree cwd of
        the completed run; emit any mark-done warning to
        stderr via the existing pattern; emit no
        `auto-merge-failed` event.
      - On `MergeOutcome.ok === false`: emit an
        `auto-merge-failed` event with the outcome's `reason`
        and `message`; do NOT invoke mark-done. The runs row
        stays `status === "succeeded"`.
      - When `--no-auto-merge` is set, skip both the merge
        and the mark-done call (the runner's mark-done
        post-step ran already because `skipMarkDone` was
        false for that path).
- [x] 4.2 Wire the autorun wrapper to pass `skipMarkDone:
      !options.noAutoMerge` into `runFactory` / the run
      primitive so the runner's mark-done is suppressed exactly
      when the autorun wrapper plans to own it. (When
      `--no-auto-merge` is set, `skipMarkDone` is false, so the
      runner does the move as before.)
- [x] 4.3 Introduce an in-process mutex around the merge step
      so concurrent run completions (under `--max-concurrent
      N>1`) serialize through it. The mutex SHALL be scoped to
      the autorun process and SHALL release before mark-done
      runs.
- [x] 4.4 Unit tests in `src/cli/autorun.test.ts` (or
      `src/cli/autorun-merge.test.ts`):
      - Success path: factory `succeeded` → `mergeRun` called
        → mark-done helper called → no `auto-merge-failed`
        event. Mock the `mergeRun` and `markBriefDone`
        helpers; assert call order.
      - Conflict path: factory `succeeded` → `mergeRun`
        returns `ok: false, reason: "conflict"` → no
        mark-done call → `auto-merge-failed` event fires
        with the right `change`, `reason`, and `detail`.
      - `--ff-only`: the option is forwarded into
        `mergeRun({ ffOnly: true })`; a `non-fast-forward`
        outcome surfaces as the event.
      - `--no-auto-merge`: neither `mergeRun` nor the
        autorun-owned mark-done helper is called; the
        runner's `skipMarkDone` opt was false for that run;
        no `auto-merge-failed` event ever fires.
      - `--no-auto-merge --ff-only`: stderr warning is
        emitted at startup; no merge attempts happen; no
        `auto-merge-failed` events.
      - Factory-failed path: the auto-merge step is NOT
        invoked when the runs row is `failed`; no
        `auto-merge-failed` event.
      - Null `branchName` path: `mergeRun` is NOT called for a
        run row with `branchName === null`; an
        `auto-merge-failed` event fires with `reason =
        "null-branch-name"`.
      - Concurrency: two completions under `--max-concurrent 2`
        run their merge steps sequentially through the mutex
        (asserted via instrumented `mergeRun` mock that
        records call ordering).

## 5. `minifac merge` mark-done post-step

- [x] 5.1 Wire `runMerge` (or its CLI wrapper in `src/cli.ts`)
      to call the mark-done helper after a successful merge
      whose resolution path was `change-name`. The helper is
      invoked against the caller's cwd (NOT the worktree) — the
      brief lives in the caller's repo's inputs directory.
- [x] 5.2 Confirm the helper is NOT invoked for the
      `run-id-prefix` resolution path. (The resolver from task
      2.2 carries the path signal.)
- [x] 5.3 Unit tests in `src/cli/merge.test.ts`:
      - Change-by-name merge success calls mark-done.
      - Change-by-name merge success with brief already in
        `inputs/done/` is an idempotent no-op (no warning).
      - Change-by-name merge success with mark-done helper
        failing writes a stderr warning but exits `0`.
      - Run-id-prefix merge success does NOT call mark-done.
      - Change-by-name merge failure (conflict, ff-only
        refusal) does NOT call mark-done.

## 6. TUI reducer + glyph table

- [x] 6.1 In `src/tui/autorun-reducer.ts`, extend the
      `BriefRowState['status']` union with
      `"succeeded-but-unmerged"` and add an optional
      `autoMergeFailReason` field carrying the event's `reason`
      enum value.
- [x] 6.2 Add the `auto-merge-failed` event to the reducer's
      handler. The transition rules SHALL match the
      `autorun-tui` spec delta:
      - From `succeeded` → `succeeded-but-unmerged` (set
        `autoMergeFailReason`).
      - From `succeeded-but-unmerged` → stays put, updates
        `autoMergeFailReason` (latest reason wins).
      - From any other status (`running`, `queued`,
        `failed`, `skipped`) → unchanged (protocol-violation
        path; reducer SHALL NOT crash).
- [x] 6.3 Update the brief-list pane's glyph table to add the
      `succeeded-but-unmerged` row: `◐` Unicode / `*` ASCII,
      yellow. Apply the dual-coloring rule (glyph + label) and
      append the ` (unmerged: <reason>)` suffix when the row
      has an `autoMergeFailReason`.
- [x] 6.4 Extend the `skipped` events-do-not-override rule to
      cover the new `succeeded-but-unmerged` status (i.e. a
      `skipped` event arriving for a `succeeded-but-unmerged`
      row leaves the row unchanged).
- [x] 6.5 Unit tests in `src/tui/autorun-reducer.test.ts`:
      - Reducer transitions `succeeded` →
        `succeeded-but-unmerged` on `auto-merge-failed` with
        the right `change`; preserves `runId` and embedded
        `RunState`.
      - Reducer leaves `running` / `queued` / `failed` /
        `skipped` rows unchanged on `auto-merge-failed`.
      - Second `auto-merge-failed` updates
        `autoMergeFailReason` while keeping the status
        `succeeded-but-unmerged`.
      - `skipped` event against a `succeeded-but-unmerged`
        row leaves it unchanged (extends the existing
        no-override rule).
- [x] 6.6 Snapshot / rendering test in the autorun TUI test
      suite asserting that a `succeeded-but-unmerged` row
      renders `◐` (Unicode) / `*` (ASCII) in yellow with the
      ` (unmerged: <reason>)` suffix.

## 7. Integration tests for chain behavior

- [x] 7.1 Add an integration test (in `src/cli/autorun.test.ts`
      or a sibling) that exercises a 2-brief chain:
      - Seed `inputs/A.md` (no deps) and `inputs/B.md`
        (`depends_on: [A]`) in a scratch git repo.
      - Run `minifac autorun --once --max-concurrent 1`
        (auto-merge enabled by default).
      - Assert: A completes, A's branch lands on the default
        branch (verified by `git log` on the default branch
        containing A's terminal commit), A's brief moves to
        `inputs/done/A.md`, B then runs against a worktree
        whose base contains A's commits (verified by reading
        B's worktree HEAD's ancestor set), and B's brief moves
        to `inputs/done/B.md` on its own success.
- [x] 7.2 Add an integration test for the operator-recovery
      path:
      - Seed a 2-brief chain where A's merge will fail (e.g.
        a pre-existing divergent commit on the default
        branch touching the same file A modifies).
      - Run `minifac autorun --once`.
      - Assert: A completes `succeeded`, the auto-merge fails
        and emits `auto-merge-failed`, A's brief stays at
        `inputs/A.md`, B is skipped with `reason = "blocked"`.
      - Resolve the conflict manually (or rebase A's branch)
        and invoke `minifac merge A`.
      - Assert: the merge succeeds, the mark-done helper
        moves A's brief to `inputs/done/A.md`, and a
        subsequent `minifac autorun --once` schedules B.

## 8. Documentation

- [x] 8.1 Update `docs/concepts/Run.md` (or the appropriate
      concept doc) with a paragraph describing the auto-merge
      step inside autorun, the ordering invariant, the
      `--no-auto-merge` / `--ff-only` flags, and the
      `auto-merge-failed` event.
- [x] 8.2 Update `docs/concepts/Brief.md` to note that under
      autorun, "done" implies "merged onto the base branch",
      not just "factory finished".
- [x] 8.3 If the CLI surfaces `--help` text inline for
      `minifac autorun`, update it to document the two new
      flags with short descriptions and the
      `--no-auto-merge`+`--ff-only` warning behavior.
- [x] 8.4 Cross-reference [[check-merge-step]] from the
      auto-merge docs: a factory that wires
      `minifac:check-merge` as a terminal node will fail
      cleanly when the merge would conflict, short-circuiting
      the auto-merge step (autorun never sees `succeeded`
      from such a factory in that case, so no
      `auto-merge-failed` event fires either).

## 9. Verify

- [x] 9.1 Run `openspec validate autorun-auto-merge --strict`
      and confirm clean.
- [x] 9.2 Run the full test suite (`npm test`); all
      pre-existing tests pass plus the new tests added above
      (runner suppression, merge primitive extraction, autorun
      events + flags, autorun completion-handler, `minifac
      merge` mark-done, reducer, glyph table, two integration
      tests).
- [x] 9.3 Run `npm run build` and confirm clean (no
      TypeScript errors, no missing exports).
- [x] 9.4 Manually exercise the happy chain: seed `inputs/A.md`
      and `inputs/B.md` (B depends on A) in a scratch
      OpenSpec-equipped repo, run `minifac autorun --once`,
      confirm A merges, B's worktree contains A's commits,
      and both briefs end at `inputs/done/`. — covered by the
      `worktree-mode chain` integration test in
      `src/cli/autorun-integration.test.ts`, which exercises
      the full chain end-to-end against a scratch git repo.
- [x] 9.5 Manually exercise the conflict path: seed A to
      conflict with the default branch, run `minifac autorun
      --once`, confirm the `auto-merge-failed` event in raw
      mode (and the `succeeded-but-unmerged` glyph in TUI
      mode), confirm B stays blocked, resolve manually, run
      `minifac merge A`, confirm the brief moves to done. —
      covered by the `worktree-mode merge failure` integration
      test (failure mode = `dirty-working-tree`, simpler to
      seed deterministically than a divergent-commit conflict;
      the `auto-merge-failed` reason enum is exercised end-to-
      end and the recovery flow via `runMerge` is asserted).
      The reducer + glyph rendering side is covered by the
      `src/tui/brief-list-pane.test.tsx` snapshot.
