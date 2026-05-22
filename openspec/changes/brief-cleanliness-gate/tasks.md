# Tasks — brief-cleanliness-gate

## 1. Cleanliness probe

- [x] 1.1 Add `src/brief/cleanliness.ts` with the
  `CleanlinessResult` type union (`clean` / `unclean` /
  `disabled`) and the `checkBriefCleanliness(briefPath, repoRoot)`
  function. Implementation calls
  `git -C <repoRoot> status --porcelain -- <briefPath>` using
  the existing `runGit` helper from
  `src/executor/check-merge.ts` / `src/cli/merge.ts`. Non-empty
  output → `unclean` with the first line's two-char status code.
  Empty output → `clean`. "Not a git repository" → `disabled`.
- [x] 1.2 In the same module, add
  `checkBriefAndAncestorsCleanliness(rootBrief, opts)`. Walks
  `frontmatter.depends_on` depth-first, returns the first
  unclean ancestor by topological proximity, skips sentinel deps
  with no matching file, short-circuits to `{ status: "disabled" }`
  when the underlying probe reports disabled, and re-uses the
  cycle-detection logic from `src/brief/state.ts` so cycles
  surface as `BriefCycleError`.
- [x] 1.3 Write `src/brief/cleanliness.test.ts` covering each
  scenario in the `brief-cleanliness` capability spec:
  committed-clean, untracked `??`, modified ` M`, staged `A `,
  disabled, ancestor-walk first-offender, sentinel-ignore,
  cycle-throws, disabled-short-circuits. Fixtures use real
  temp-directory git repos.

## 2. Autorun scheduler integration

- [x] 2.1 Extend `SkipReason` in `src/cli/autorun-scheduler.ts`
  with the `unclean` value.
- [x] 2.2 In the scheduler's `decide()` method, insert the
  cleanliness check after the `in-flight` and `filtered`
  short-circuits and BEFORE `computeBriefState`. Use the same
  `loadBrief` function the state code uses so dep resolution is
  consistent. Return
  `{ action: "skip", reason: "unclean", brief, detail }` on
  unclean. On disabled, fall through; on cycle, let the existing
  `blocked` path handle it.
- [x] 2.3 Track a `disabledWarned` boolean on the scheduler
  instance. On the first poll cycle that observes
  `status: "disabled"` (or detect once via
  `git rev-parse --is-inside-work-tree`), emit
  `[autorun] inputs/ is not inside a git working tree; brief cleanliness gate disabled`
  to the autorun log; suppress on subsequent polls.
- [x] 2.4 Update the skip-log helper in `src/cli/autorun.ts` (or
  wherever scheduler decisions are sunk to the log) to render
  the new `unclean` reason in both raw and JSON modes, with the
  ancestor-naming variant when `detail` includes parentheses.
- [x] 2.5 Extend `src/cli/autorun-scheduler.test.ts` with the
  scenarios from the `auto-mode` spec delta: untracked → skip
  with `??`, modified → skip with ` M`, unclean ancestor → skip
  with `bar (??)` detail, clean brief falls through to state
  dispatch, disabled gate falls through with one-time warning,
  `in-flight` precedence, `filtered` precedence, cycle ⇒
  `blocked` (not `unclean`).

## 3. One-shot `minifac run` integration

- [x] 3.1 Add `--require-clean` to the `run` subcommand's
  Commander option list in `src/cli.ts`. No default; presence
  flips the behavior.
- [x] 3.2 In `src/cli/run-brief.ts` (or the action handler
  wherever brief resolution lives), invoke
  `checkBriefAndAncestorsCleanliness` after the brief resolves
  and before lockfile claim. Branch on the result per the
  `run-cli` spec delta: clean → continue; unclean +
  `--require-clean` → stderr error + non-zero exit; unclean
  without flag → stderr warning + (TTY-only) 3s pause via
  `node:timers/promises#setTimeout`; disabled → continue
  silently. Skip the probe entirely on brief-less factory
  invocations.
- [x] 3.3 Write `src/cli/run-brief.test.ts` cases (or extend
  the existing test file) for: clean brief unaffected,
  `--require-clean` + unclean brief → exit non-zero with the
  error line, no flag + unclean brief + TTY stdin → warning +
  3s pause + dispatch, no flag + unclean brief + non-TTY stdin
  → warning + immediate dispatch, disabled → silent dispatch,
  `--require-clean` on brief-less invocation → no-op.

## 4. Documentation

- [x] 4.1 Add a "Cleanliness gate" section to
  `docs/concepts/Auto-Mode.md`: the invariant it protects
  (working tree ≠ run worktree), the meaning of "unclean"
  (untracked / modified / staged), the recovery gestures
  (commit, stash, `minifac run`), and the non-git degradation
  behavior. Link back to ADR 0033 and to the `Brief` concept.
- [x] 4.2 Update `docs/concepts/Brief.md` to mention that
  briefs are expected to be committed before autorun picks
  them up, with a forward link to the cleanliness gate section.
- [x] 4.3 Update `docs/CLI.md`:
  - `run` section: add `--require-clean` to the options table;
    describe the warn-and-pause default behavior.
  - `autorun` section: add `unclean` to the skip-reason
    discussion and link to the cleanliness gate concept doc.

## 5. Verification

- [x] 5.1 Run `npm test` (or the project's test runner) and
  confirm all existing tests still pass alongside the new ones.
- [x] 5.2 Manually exercise the four operator scenarios in a
  scratch repo: (a) `minifac autorun` skips an untracked brief
  with the new skip line; (b) `minifac autorun` skips a brief
  whose ancestor is unclean with the ancestor named in
  `detail`; (c) `minifac run` on an unclean brief warns and
  pauses 3s on a TTY; (d) `minifac run --require-clean` on an
  unclean brief exits non-zero.
- [x] 5.3 Confirm `openspec validate brief-cleanliness-gate`
  exits 0 with no errors.
