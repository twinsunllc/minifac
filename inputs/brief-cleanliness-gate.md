---
change: brief-cleanliness-gate
factory: sdd
base_branch: main
---

## Background

`minifac autorun` will pick up and dispatch a brief whose
`inputs/<change>.md` file is uncommitted (untracked, modified,
or staged-but-uncommitted). The run worktree is created from a
git ref and sees the *committed* copy of the brief, while the
scheduler dispatched based on the *working-tree* copy. Operator
and spawned process can silently disagree about the spec.

Briefs are first-class git-tracked artifacts (see
[[0015-Brief-Deps-and-State]]). Letting autorun fire on
non-committed files breaks that invariant.

The binding decision is at
`docs/decisions/0033-Brief-Cleanliness-Gate.md`. Read it
first. Key calls locked:

- **Autorun unconditionally skips unclean briefs** with a new
  skip reason `unclean`. No flag to bypass — commit, stash, or
  use `minifac run` instead.
- **One-shot `minifac run` warns + pauses 3s, then proceeds.**
  Preserves the dogfood-before-commit authoring loop.
- **New flag `minifac run --require-clean`** converts the warning
  into a hard error. For CI / strict use.
- **The gate is brief-file-scoped only.** Working-tree WIP in
  unrelated areas (`src/`, `docs/`) does NOT trip the gate.
- **`depends_on` ancestors are checked recursively.** An unclean
  ancestor fails the gate for its descendants.
- **Outside a git working tree → gate disabled** with a one-time
  startup warning.

## What to do

### 1. Cleanliness probe helper

Add a new module `src/brief/cleanliness.ts` exposing:

```typescript
export interface UncleanResult {
  status: "unclean";
  /** Two-char porcelain status code, e.g. "??", " M", "A " */
  code: string;
}

export interface CleanResult {
  status: "clean";
}

export interface DisabledResult {
  status: "disabled";
  reason: "not-a-git-repo";
}

export type CleanlinessResult = CleanResult | UncleanResult | DisabledResult;

export async function checkBriefCleanliness(
  briefPath: string,
  repoRoot: string,
): Promise<CleanlinessResult>;
```

Implementation calls `git -C <repoRoot> status --porcelain -- <briefPath>`.
Non-empty output → unclean with the first line's status code.
Empty output → clean. Failure with "not a git repository" message
→ disabled.

Reuse the existing `runGit` helper from `src/executor/check-merge.ts` /
`src/cli/merge.ts` rather than introducing a new git subprocess
wrapper.

### 2. Recursive check for `depends_on` ancestors

Add a sibling helper:

```typescript
export async function checkBriefAndAncestorsCleanliness(
  rootBrief: Brief,
  opts: { inputsDir: string; repoRoot: string; loadBrief: (change: string) => Promise<Brief> },
): Promise<{ status: "clean" | "disabled" } | { status: "unclean"; offending: string; code: string }>;
```

Walks `frontmatter.depends_on` recursively. First unclean ancestor
encountered returns `{ status: "unclean", offending: <change>, code }`.
Cycle handling: reuse the existing cycle-detection logic from
`src/brief/state.ts` — bail with `BriefCycleError` if a cycle is
hit, since the scheduler already handles that case via the
`blocked` skip reason.

Sentinel deps (e.g., `callback-status-signaling-design-pending`)
that don't correspond to a real brief file are **ignored** by the
cleanliness check, mirroring how the state machine treats them as
permanently `missing`.

### 3. Autorun SkipReason extension

Add `unclean` to `SkipReason` in
`src/cli/autorun-scheduler.ts`:

```typescript
export type SkipReason =
  | "blocked"
  | "concurrency"
  | "failure-cap"
  | "filtered"
  | "in-flight"
  | "running-elsewhere"
  | "activity-succeeded"
  | "done"
  | "unclean";       // NEW
```

### 4. Scheduler decide() integration

In `decide()`, run the cleanliness check after the early `in-flight`
and `filtered` short-circuits but **before** `computeBriefState`.
Rationale: a brief in flux shouldn't even have its state computed
— the working-tree copy is unreliable input.

```typescript
const cleanliness = await checkBriefAndAncestorsCleanliness(brief, {
  inputsDir: this.deps.inputsDir,
  repoRoot: this.deps.repoRoot,
  loadBrief: /* same loader the state code uses */,
});
if (cleanliness.status === "unclean") {
  return {
    action: "skip",
    reason: "unclean",
    brief,
    detail: cleanliness.offending === change
      ? cleanliness.code
      : `${cleanliness.offending} (${cleanliness.code})`,
  };
}
// disabled → fall through to normal scheduling (gate is a no-op)
```

### 5. Disabled-gate startup warning

When the autorun process initializes its scheduler, run the
cleanliness check once against any brief (or detect via
`git rev-parse --is-inside-work-tree`). If disabled, emit a one-time
warning to the autorun log:

```
[autorun] inputs/ is not inside a git working tree; brief cleanliness gate disabled
```

This warning fires once per process, not per poll cycle.

### 6. One-shot `minifac run` integration

In `src/cli.ts`'s `run` subcommand action handler:

- After resolving the brief but before dispatching the factory,
  run `checkBriefAndAncestorsCleanliness`.
- If unclean and `--require-clean` was passed, print a clear error
  to stderr and exit with non-zero status:

  ```
  error: brief inputs/<offending>.md is uncommitted (<code>).
  commit it or drop --require-clean to proceed.
  ```

- If unclean and `--require-clean` was NOT passed, print a warning
  to stderr:

  ```
  warning: brief inputs/<offending>.md is uncommitted (<code>); the
  run worktree will see the committed version, which may differ.
  proceed anyway in 3s... (Ctrl-C to abort)
  ```

  Pause 3 seconds (`setTimeout` returning a promise the run path
  awaits), then continue. The pause is suppressed entirely when
  `process.stdin.isTTY` is falsy.

- If disabled (no git repo), no warning, no pause — just dispatch.

### 7. `--require-clean` flag

Add to `minifac run` in `src/cli.ts`:

```typescript
.option("--require-clean", "Refuse to run if the brief or any depends_on ancestor is uncommitted")
```

No default; presence of the flag flips the behavior. Document in
both `--help` and `docs/CLI.md`.

### 8. Logging helper update

The skip-log helper that handles `kind: "skipped"` lines in
`src/cli/autorun.ts` (or wherever the scheduler's decisions are
sunk to the log) needs a new case for `unclean`:

**Raw mode:**
```
[autorun] skipped <change>: brief is uncommitted (<code>); commit or stash before autorun picks it up
```

If the offending brief is an ancestor (different from `<change>`),
say so:
```
[autorun] skipped <change>: ancestor brief <offending> is uncommitted (<code>); commit or stash before autorun picks it up
```

**JSON mode:**
```json
{"kind":"skipped","ts":...,"change":"<change>","reason":"unclean","detail":"<code>"}
```

or for the ancestor case:
```json
{"kind":"skipped","ts":...,"change":"<change>","reason":"unclean","detail":"<offending> (<code>)"}
```

### 9. Tests

Cover at least:

**Cleanliness probe (`src/brief/cleanliness.test.ts`):**
- Returns `clean` for a committed brief
- Returns `unclean` with code `??` for an untracked brief
- Returns `unclean` with code ` M` for a modified-but-tracked brief
- Returns `unclean` with code `A ` for a staged-but-uncommitted brief
- Returns `disabled` for a brief in a non-git directory
- Ancestor walk surfaces the *first* unclean ancestor by topological
  proximity
- Ancestor walk ignores sentinel `depends_on` entries (no file)
- Cycle in `depends_on` → BriefCycleError (propagates to scheduler)

**Scheduler integration (`src/cli/autorun-scheduler.test.ts`):**
- Unclean brief → `{ action: "skip", reason: "unclean", detail: "??" }`
- Unclean ancestor → skip with `detail: "ancestor-name (??)"`
- Clean brief → falls through to existing state-based dispatch logic
- Disabled gate (non-git) → falls through; warning emitted once
- `unclean` precedence: `in-flight` and `filtered` still short-circuit
  *before* the cleanliness check

**One-shot `run` (`src/cli/run-brief.test.ts` or similar):**
- `--require-clean` + unclean brief → exits non-zero with stderr error
- No flag + unclean brief + TTY stdin → warning + 3s pause + dispatch
- No flag + unclean brief + non-TTY stdin → warning + immediate dispatch
- Clean brief → no warning, no pause, dispatch as today
- Disabled gate (non-git) → no warning, dispatch

Use `simple-git` or shell-out to a temp directory to set up the
test fixtures with actual git state.

### 10. Concept doc

Update `docs/concepts/Auto-Mode.md` with a "Cleanliness gate"
section covering:

- The invariant the gate protects (working tree ≠ run worktree)
- What "unclean" means (untracked / modified / staged)
- How to recover (commit, stash, or use `minifac run`)
- The non-git degradation behavior

Update `docs/concepts/Brief.md` to mention that briefs are
expected to be committed before they're picked up by autorun.

### 11. CLI reference

Update `docs/CLI.md`:

- `run` section: add `--require-clean` to the options table; mention
  the warn-and-pause default behavior
- `autorun` section: add `unclean` to the skip-reason discussion;
  link to the cleanliness gate concept doc

### 12. Spec deltas

`autorun` capability: MODIFY existing requirements to describe the
cleanliness gate. ADD a scenario covering autorun skipping an
unclean brief, and another for an unclean ancestor.

`run-cli` capability: MODIFY to describe the warn-and-pause
behavior on unclean briefs and the `--require-clean` flag.

NEW shared capability or fold into existing — your judgment —
covering the cleanliness probe as a testable contract.

## Out of scope

- Extending the gate to factory files (`.minifac/factories/*.yaml`).
  Same problem, separate brief.
- Auto-committing the brief before dispatch.
- Hashing brief content to detect mid-run drift.
- Whole-working-tree cleanliness check.
- Per-brief frontmatter opt-out.
- Making the 3s pause duration configurable.

## Acceptance criteria

- `minifac autorun` skips an uncommitted brief with reason `unclean`
  and a clear log line in both raw and JSON modes
- An unclean ancestor brief causes the descendant to skip with the
  ancestor named in `detail`
- `minifac run <change>` on an unclean brief prints a warning and
  pauses 3s on a TTY (immediate on non-TTY) before proceeding
- `minifac run <change> --require-clean` on an unclean brief exits
  non-zero with a clear error
- Clean briefs behave exactly as before — no warnings, no pauses
- Inputs outside a git working tree disable the gate with a one-time
  startup warning; all dispatching proceeds normally
- Existing skip reasons (`in-flight`, `filtered`) still take
  precedence over `unclean`
- All existing tests pass
- Concept doc and CLI reference reflect the new behavior
