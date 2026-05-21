## 1. Brief schema: `depends_on`

- [x] 1.1 Add `depends_on: z.array(z.string().min(1)).optional().default([])`
      to `BriefFrontmatterSchema` in `src/brief/schema.ts`. Keep
      `.passthrough()` so other unknown extras still pass through.
- [x] 1.2 Update `src/brief/loader.test.ts` (or the schema test
      file, whichever is canonical) with cases covering:
      - `depends_on` absent → frontmatter exposes `[]`
      - `depends_on: ["bar", "baz"]` → array preserved in order
      - `depends_on: "bar"` (non-array) → `BriefLoadError` naming
        the field
      - `depends_on: ["bar", 42]` → `BriefLoadError` naming the
        offending element
      - `depends_on: ["bar", ""]` → `BriefLoadError` naming the
        empty-string element
      - Existing scenarios in `brief-schema/spec.md` continue to
        pass unchanged.
- [x] 1.3 Update `examples/sample-brief.md` to add a commented
      `depends_on:` entry showing the canonical shape and noting
      that the loader defaults missing values to `[]`.

## 2. Brief doneness derivation

- [x] 2.1 Create `src/brief/doneness.ts` exporting
      `type Doneness = "active" | "done" | "missing"` and
      `computeBriefDoneness(change, { inputsDir, repoRoot }):
      { doneness, filePath? }`. Resolution order is `<inputsDir>/
      <change>.md` → `<inputsDir>/done/<change>.md` → `missing`.
      Use `fs.existsSync`; no git plumbing.
- [x] 2.2 Add `src/brief/doneness.test.ts` covering all three
      doneness outcomes (active, done, missing) plus the
      both-locations case (active wins).

## 3. Brief activity derivation

- [x] 3.1 Create `src/brief/activity.ts` exporting
      `type Activity = "none" | "running" | "succeeded" | "failed"`
      and `computeBriefActivity(change, { runStore }): Promise<{
      activity, mostRecentRunId?, branchName?, endedAt? }>`.
      Implementation calls `runStore.listRuns({ change, limit: 1 })`
      and maps the first row's `status` to the activity literal;
      `none` when no row exists.
- [x] 3.2 Add `src/brief/activity.test.ts` using a fake RunStore
      (in-memory implementation of the `RunStore` interface, or
      the existing SQLite adapter in a temp file) covering:
      no rows → `none`; running → `running`; succeeded → `succeeded`;
      failed → `failed`; multiple rows → most-recent wins.

## 4. Combined state + cycle detection

- [x] 4.1 Create `src/brief/state.ts` exporting `BriefCycleError`,
      `BriefStateResolution`, and
      `computeBriefState(change, { inputsDir, repoRoot, runStore,
      loadBrief? }): Promise<BriefStateResolution>`.
      Implementation:
      - Load the root brief (best-effort; treat a missing-but-named
        root as `doneness: "missing"`, `blocked: true`,
        `blockedReason: "brief file not found"`).
      - Walk `depends_on` with a visited set to detect cycles;
        throw `BriefCycleError` with the full path.
      - Compute each dep's `doneness` via `computeBriefDoneness`.
      - Compute the root's `doneness` and `activity`; set `blocked
        = deps.some(d => d.doneness !== "done")`; build
        `blockedReason` naming unsatisfied deps.
- [x] 4.2 Add `src/brief/state.test.ts` covering: no deps;
      all-done deps; one dep `active`; one dep `missing`;
      multiple unsatisfied deps; deep dep chain (immediate dep
      `done`, transitive `active`, not blocked); self-loop;
      two-node cycle; three-node cycle.

## 5. Runner refuses blocked briefs

- [x] 5.1 In `src/cli/resolve.ts` (or wherever the run action
      builds its plan before the worktree step), once a brief is
      resolved, invoke `computeBriefState(change, ...)` before
      lockfile claim. If `state.blocked` and `--force` was not
      passed, write a stderr message naming each unsatisfied dep
      and its doneness, and `process.exit(1)`. Surface
      `BriefCycleError` as a usage error regardless of `--force`.
- [x] 5.2 Wire a `--force` flag onto the `run` subcommand in
      `src/cli.ts` (it should pass through to `resolve.ts`). With
      `--force`, the blocked path SHALL emit a single stderr
      warning and continue.
- [x] 5.3 Update `src/cli/resolve.test.ts` (or the matching CLI
      test file) with scenarios mirroring the new `run-cli` spec
      scenarios: dep `active` blocks; dep `missing` blocks; deps
      `done` proceed; `--force` overrides; cycle is refused even
      with `--force`.

## 6. Mark-done post-step

- [x] 6.1 Add a mark-done function. Either fold into
      `src/runner/run.ts` (small helper inside the same module)
      or add `src/runner/mark-done.ts` exporting a function the
      runner calls. The function SHALL:
      - Accept `{ change, runCwd }`.
      - Resolve `<runCwd>/inputs/<change>.md` and
        `<runCwd>/inputs/done/<change>.md`.
      - Idempotent-skip when the source is absent and the dest
        exists.
      - Otherwise: ensure `<runCwd>/inputs/done/` exists; run
        `git -C <runCwd> mv inputs/<change>.md
        inputs/done/<change>.md`; then `git -C <runCwd> commit -m
        "Mark <change> done"`.
      - Return a `{ moved: boolean, warning?: string }` shape;
        warnings carry the git stderr.
- [x] 6.2 In `src/runner/run.ts` (or the CLI runner wrapper, depending
      on where terminal-success is observed), invoke the mark-done
      function before the final `finalizeRun({ status: "succeeded" })`
      call. Only invoke when the run is brief-driven (skip
      brief-less factory runs). Log warnings to stderr but do
      NOT change the terminal status on failure.
- [x] 6.3 Add `src/runner/mark-done.test.ts` (or extend `run.test.ts`)
      covering: success (file moved, commit lands); idempotent
      skip (file already in `done/`); `git mv` failure (warning
      logged, run still `succeeded`); brief-less run (mark-done
      not invoked); failed run (mark-done not invoked).
      The tests SHALL use a real `git init` temp repo, not mocks,
      so the `git mv` path is exercised.

## 7. `minifac briefs` subcommand

- [x] 7.1 Create `src/cli/briefs.ts` mirroring the shape of
      `src/cli/runs.ts`. The module SHALL:
      - Parse flags `--state`, `--activity`, `--ready`, `--inputs
        <d>`, `--json`.
      - Enumerate active briefs from `<inputs>/*.md` and done
        briefs from `<inputs>/done/*.md`.
      - For each, load the brief (best-effort) and compute state.
      - Apply filters; sort by `change` ascending.
      - Emit table or JSON.
- [x] 7.2 Wire `briefs` into the commander setup in `src/cli.ts`.
- [x] 7.3 Add `src/cli/briefs.test.ts` covering: default listing;
      `--state active`; `--state` rejects bad value;
      `--activity running`; `--ready` excludes blocked briefs;
      `--ready` excludes in-flight runs; `--ready` includes
      failed runs; `--json` emits stable sorted array;
      `--inputs` overrides the default; unparseable brief
      reports `parse_error` activity; empty inputs dir exits `0`.

## 8. Docs

- [x] 8.1 Update `docs/concepts/Brief.md`: rewrite the Lifecycle
      section to describe the two-axis model (doneness in git,
      activity in runs.db). Document `inputs/done/` as the
      destination for completed briefs and the runner's mark-done
      post-step.
- [x] 8.2 Add a short section to `examples/sdd.md` (or the
      `README.md`, whichever is the canonical onboarding doc)
      showing how to author a dependent brief: a `depends_on`
      example with a one-paragraph explanation.
- [x] 8.3 Audit `docs/Open-Questions.md`: confirm that no "Brief
      dependencies and state" entry remains (already removed in
      a prior change). If the entry has been re-added since,
      remove it. Leave any remaining entries (including the
      "Prune leaves orphaned branches behind" entry, if still
      present) untouched.

## 9. Validation

- [x] 9.1 Run `openspec validate brief-deps-and-state --strict`
      and confirm exit `0`.
- [x] 9.2 Run `npm test` (or the project's equivalent) and
      confirm the existing 332+ tests still pass alongside the
      new ones.
- [x] 9.3 Manual smoke test: author a `depends_on` brief in the
      repo, attempt to `minifac run` it before its dep is done
      (expect refusal), then move the dep to `inputs/done/` and
      re-run (expect success + the brief gets moved automatically
      on terminal-success). Confirm `minifac briefs` reflects the
      transitions.
