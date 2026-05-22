## 1. Check-merge executor

- [x] 1.1 Create `src/executor/check-merge.ts` exporting a
      `CheckMergeExecutor` class that implements `NodeExecutor`
      with `type === "check-merge"`. Constructor takes no
      arguments (no per-instance config). `run(node, ctx)` returns
      an `AsyncIterable<NodeEvent>`.
- [x] 1.2 In the same module, add a `with:` validator that accepts
      exactly `{ base?: string, mode?: "any-merge" | "fast-forward" }`
      and rejects all other keys. Validation failures yield a
      single `status: "failed"` event whose message names the
      offending key (or the offending `mode` value) and never
      proceed to git invocation. Default `mode` to `"any-merge"`
      when absent.
- [x] 1.3 Implement the primary probe path via
      `git -C <cwd> merge-tree --write-tree --name-only <base> HEAD`.
      Treat exit 0 with empty stdout as clean, exit 1 (conflicts
      reported on stdout) as conflicting (record the conflict
      count or path list for the failure message), and exit 128
      ("unknown flag", older git) as the trigger for the
      fallback path. Surface other non-zero exits as
      `status: "failed"` with the stderr included in the
      message.
- [x] 1.4 Implement the fallback path: spawn
      `git -C <cwd> merge --no-commit --no-ff <base>` followed
      unconditionally by `git -C <cwd> merge --abort` in a
      `finally` block. The merge spawn's exit code (0 = clean,
      non-zero = conflict) determines the outcome. The abort
      SHALL run even on success-path exit so the worktree-clean
      invariant holds in both branches.
- [x] 1.5 Implement the `mode: "fast-forward"` precheck: invoke
      `git -C <cwd> merge-base --is-ancestor <base> HEAD`. Exit 0
      → fast-forward is possible (continue to the conflict
      probe, which under `any-merge` would also pass but under
      `fast-forward` short-circuits to success). Exit 1 → base
      is not an ancestor; emit `status: "failed"` with a message
      naming "merge commit required under fast-forward mode".
      Run this precheck BEFORE the merge-tree probe under
      `fast-forward`; skip it entirely under `any-merge`.
- [x] 1.6 Wrap the entire probe in a worktree-state snapshot:
      capture `HEAD` (rev-parse), `git status --porcelain`,
      `ls .git/MERGE_HEAD .git/MERGE_MSG .git/MERGE_MODE
      .git/AUTO_MERGE` (with content hashes for any that
      exist), and the untracked-file set. After the probe (in
      a `finally` block), assert equality of all four; on
      mismatch the executor SHALL crash with a clear message
      naming the assertion that failed — this is a programmer
      error, not a user error, and crashing fail-loud is
      preferable to silently corrupted state.
- [x] 1.7 Register the executor in `defaultRegistry()`
      (`src/cli.ts`) alongside `ClaudeExecutor`. Export
      `CheckMergeExecutor` from `src/index.ts`.
- [x] 1.8 Unit tests in `src/executor/check-merge.test.ts`. Use
      temp git repos seeded with fixture commits (helper module
      under `src/executor/check-merge.fixtures.ts` or inline).
      Cover:
      - Fast-forward case passes under `any-merge`.
      - Fast-forward case passes under `fast-forward`.
      - Divergent-but-clean merge passes under `any-merge`.
      - Divergent-but-clean merge fails under `fast-forward` with
        a "merge commit required" message.
      - Conflicting merge fails under `any-merge`.
      - Conflicting merge fails under `fast-forward`.
      - Missing-branch base fails with a message naming the bad
        base.
      - Worktree-clean invariant holds in every scenario above
        (snapshot before, assert equality after).
      - `with: { base: "" }` (empty after substitution) fails
        with the "declare `base` explicitly" message.
      - `with: { mode: "rebase" }` fails as unknown mode value.
      - `with: { strategy: "ours" }` fails as unknown `with:`
        key.
      - Final event is always a `status` event with one of
        `succeeded` / `failed`.

## 2. Built-in step file

- [x] 2.1 Create `examples/steps/check-merge.yaml` matching the
      shape required by the `check-merge-step` spec: `name:
      check-merge`, `version: "1.0.0"` (or similar), a single-
      paragraph `description`, `executor: check-merge`,
      `inputs: { base: { type: "string", required: false,
      default: "{{ run.base_branch }}" }, mode: { type: "string",
      required: false, default: "any-merge" } }`, `with: { base:
      "{{ inputs.base }}", mode: "{{ inputs.mode }}" }`.
- [x] 2.2 Confirm the step file passes through the existing
      `loadStep(...)` loader without modification (the step
      loader already accepts `string` inputs with string
      defaults). Add a test in
      `src/step/builtin-steps.test.ts` (new file or extend
      existing) that loads each of the four `openspec-*` step
      files AND the new `check-merge.yaml` cleanly.
- [x] 2.3 Confirm `resolveStepRef("minifac:check-merge", <cwd>)`
      returns the absolute path to the bundled file (using the
      package-root / source-tree fallback per ADR 0030). Add a
      resolver test alongside the existing built-in resolution
      tests.

## 3. `run.base_branch` templating

- [x] 3.1 Extend `src/factory/templating.ts` (or wherever brief/
      run substitution lives) to recognize `run.base_branch` as
      a third `run`-scope token. Stringification rules match
      `run.cwd` (it's a plain string).
- [x] 3.2 Thread a `runBaseBranch` field through `RunOptions` /
      `runFactory` (`src/runner/run.ts`) and into the templating
      pass. The CLI run path (`src/cli/run.ts` or wherever the
      worktree-aware run command lives) SHALL supply the worktree's
      base branch as `runBaseBranch`. The in-place run path SHALL
      supply the empty string (or omit the field, depending on
      which the templating distinguishes).
- [x] 3.3 Apply the same substitution pass to `with.base` (string
      field) that today applies to `with.prompt` and `cwd`. This
      keeps the substitution surface narrowly defined (named
      string fields) rather than generic deep-walk — consistent
      with the existing approach.
- [x] 3.4 Unit tests in `src/factory/templating.test.ts`:
      - `{{ run.base_branch }}` in `with.base` substitutes to the
        runner's `runBaseBranch` value.
      - `{{ run.base_branch }}` in `with.prompt` substitutes
        too.
      - Empty `runBaseBranch` substitutes to empty string.
      - Unset `runBaseBranch` (not passed) leaves the token
        verbatim.
      - Unknown `run.*` field (e.g. `run.id`) still passes
        through verbatim — regression of the existing
        scenario.

## 4. SDD factory adoption

- [x] 4.1 Edit `examples/sdd.yaml`: add the new `check-merge`
      node block:
      ```yaml
      check-merge:
        uses: minifac:check-merge
        cwd: "{{ run.cwd }}"
        terminal: true
      ```
      Remove `terminal: true` from `archive`. Add the
      `archive → check-merge` edge to the `edges:` block.
- [x] 4.2 Update `src/factory/sdd-example.test.ts` (the
      structural test) to assert:
      - Five nodes, exactly `{propose, apply, verify, archive,
        check-merge}`.
      - The new edge set including `archive → check-merge`.
      - `check-merge.terminal === true`; `archive.terminal`
        falsy.
      - `check-merge` resolved `executor === "check-merge"`;
        each of the four claude nodes resolved
        `executor === "claude"`.
      - `check-merge` resolved `with.base === "{{ run.base_branch }}"`
        and `with.mode === "any-merge"`.
      - `check-merge.cwd === "{{ run.cwd }}"`.
      - `check-merge`'s resolved `with` declares no
        `permission_mode` / `allowed_tools` / `add_dirs`.
- [x] 4.3 Update the regression snapshot (the deep-equal fixture
      used by `examples/sdd.yaml` for drift detection, per the
      reusable-steps regression test). Add the check-merge node
      to the expected shape.
- [x] 4.4 Update `examples/sdd.md` to document the fifth node:
      its placement (after `archive`), its role (mergeability
      probe), its terminal status, and the fact that a probe
      failure leaves the brief at `inputs/<change>.md` for
      operator intervention. Cross-reference
      `inputs/autorun-auto-merge.md` for the upcoming
      auto-merge story.

## 5. Composability test fixture

- [x] 5.1 Add a small example or test-only fixture factory that
      wires `check-merge` into a graph with an explicit
      `on_failure` edge (e.g. `check-merge → cleanup` on
      failure). This covers the brief's acceptance criterion
      "An example factory or test fixture wires
      `minifac:check-merge` into a graph; the `on_failure` edge
      routes elsewhere on conflict." The shipped SDD factory
      does NOT declare such an edge in v0 (per the SDD spec
      delta); a test fixture is sufficient.
- [x] 5.2 Unit / integration test that loads the fixture, runs
      it against a deliberately conflicting worktree, and
      asserts the `on_failure` edge fires and the downstream
      node runs.

## 6. Documentation

- [x] 6.1 Add a short paragraph to `docs/concepts/Factory.md`
      noting `minifac:check-merge` as a bundled built-in that
      probes mergeability read-only, with a one-line example.
- [x] 6.2 Add a short paragraph to `docs/concepts/Step.md` (in
      the "bundled built-ins" section, if one exists; otherwise
      a "see also" line) referencing `check-merge`.
- [x] 6.3 Update `docs/Open-Questions.md`: the cycle-on-conflict
      edge story now has the probe prerequisite satisfied; the
      remaining gate is structured node-outputs. Tweak the
      wording to reflect that, without closing the question.
- [x] 6.4 If `README.md` enumerates bundled built-ins or built-in
      steps, add `check-merge` to the list. Otherwise skip — the
      README pitch already references the bundled step library
      generically.

## 7. Verify

- [x] 7.1 Run `openspec validate check-merge-step --strict` and
      confirm clean.
- [x] 7.2 Run the full test suite (`npm test`); all pre-existing
      tests pass plus the new tests added above (executor,
      step file load, resolver, templating, SDD structural +
      regression, composability fixture).
- [x] 7.3 Run `npm run build` and confirm clean (no TypeScript
      errors, no missing exports).
- [x] 7.4 Manually invoke the migrated SDD factory against a
      scratch OpenSpec-equipped repo via `minifac run <change>`.
      Confirm: the five nodes run in order, `check-merge`
      executes after `archive`, the probe passes cleanly when
      the worktree is mergeable, and the run ends `succeeded`.
- [x] 7.5 Manually exercise the failure path: stage a worktree
      whose `HEAD` conflicts with `main` (e.g. by changing a
      file on `main` that the run's branch also changed),
      invoke `minifac run <change>`, and confirm `check-merge`
      fails, the run ends `failed`, and the brief stays at
      `inputs/<change>.md`.
