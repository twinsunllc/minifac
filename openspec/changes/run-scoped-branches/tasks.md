## 1. Schema migration: `branch_name` column

- [x] 1.1 Create `src/storage/migrations/0002_add_branch_name.sql`
      containing the single statement
      `ALTER TABLE runs ADD COLUMN branch_name TEXT;`.
- [x] 1.2 Mirror the migration in
      `src/storage/migrations/index.ts`'s inline `MIGRATIONS`
      array as `{ version: 2, name: "add_branch_name", sql: ...
      }`. Verify `highestMigration()` returns `2`.
- [x] 1.3 Verify in a unit test that opening a brand-new
      database applies versions `1` and `2`, leaves
      `schema_version.version = 2`, and that the `runs` table
      has a `branch_name` column (introspect via
      `PRAGMA table_info(runs)`).
- [x] 1.4 Verify in a unit test that opening an existing v1
      database (seeded with rows that have no `branch_name`)
      applies migration `0002`, leaves `schema_version.version
      = 2`, and that the prior rows survive with
      `branch_name = NULL`.

## 2. `RunStore` interface and SQLite adapter

- [x] 2.1 Extend the `RunStore` interface in
      `src/storage/run-store.ts`: `CreateRunInput` gains
      `branchName?: string`; the returned `Run` shape gains
      `branchName: string | null`. Update any type aliases or
      filter shapes used by `listRuns` if necessary.
- [x] 2.2 Update the SQLite adapter to:
      (a) include `branch_name` in the `INSERT INTO runs` column
          list, binding `input.branchName ?? null`;
      (b) project `branch_name` in the `SELECT` used by
          `getRun` and `listRuns`, mapping it to `branchName`
          in the returned object;
      (c) preserve existing behavior for every other column.
- [x] 2.3 Extend the adapter's tests to cover:
      `createRun` with `branchName` persists and round-trips;
      `createRun` without `branchName` round-trips as `null`;
      `listRuns` returns `branchName` per row (mixed
      null/non-null in the result set).

## 3. Worktree paths and branch naming helpers

- [x] 3.1 In `src/worktree/paths.ts`, add:
      `runSlugFromId(runId: string): string` →
      `runId.slice(0, 6).toLowerCase()`;
      `runBranchName(changeOrFactory: string, slug: string):
      string` → `run/${changeOrFactory}-${slug}`;
      `runWorktreeDirName(changeOrFactory: string, slug:
      string): string` → `run-${changeOrFactory}-${slug}`;
      `runWorktreePathForDir(config, dirName)`: returns the
      absolute path under `worktreesDir`.
- [x] 3.2 Add tests in `src/worktree/paths.test.ts`:
      slug is the first 6 chars lowercased; branch shape is
      `run/<x>-<slug>`; dir shape is `run-<x>-<slug>`; helpers
      work for both the brief-driven (`change`) and brief-less
      (`factory`) callers (no special-case needed — the
      helpers take the segment opaquely).
- [x] 3.3 Leave `worktreeKeyForBrief` and
      `worktreeKeyForFactory` unchanged — they continue to
      build the lockfile key (`<repo-hash>-<change>` /
      `<repo-hash>-<factory>-<timestamp>`).

## 4. CLI run action: build branch + persist branch_name

- [x] 4.1 In the run action (the file currently sequencing
      resolve → lazy-prune → claim-lock → create-worktree →
      runner-invoke → finalize), compute:
      - `runId` (already generated for the runs DB row),
      - `slug = runSlugFromId(runId)`,
      - `segment = brief ? brief.change : factory.name`,
      - `branchName = runBranchName(segment, slug)`,
      - `worktreeDirName = runWorktreeDirName(segment, slug)`,
      - `worktreePath = path.join(config.worktreesDir,
        worktreeDirName)`.
- [x] 4.2 Pass `branchName` and `worktreePath` to the
      `git worktree add` shell-out (the `git.ts` wrapper).
- [x] 4.3 Include `branchName` in the `createRun` input when
      persisting the new run row.
- [x] 4.4 Leave the lockfile claim using the existing
      `worktreeKeyForBrief` / `worktreeKeyForFactory` key — do
      NOT switch the lockfile to the new dir naming.
- [x] 4.5 Update existing run-action tests that asserted the
      old `<repo-hash>-<change>` worktree directory name to
      expect `run-<change>-<slug>` instead. Slug values in
      tests come from the deterministic test run-id (mock the
      UUID generator or accept any-slug matchers as the suite
      prefers).

## 5. Lockfile-refused message update

- [x] 5.1 In `src/worktree/lock.ts` (or wherever the
      refused-claim error is constructed), extend the error
      payload / message to include:
      - the existing fields (holding PID, key, lock path),
      - a clarification line that the lockfile serializes
        same-change invocations even though their branches no
        longer collide,
      - a reference to the future `--factory` flag described
        in `docs/decisions/0020-Factory-Override-At-Invocation.md`.
- [x] 5.2 Extend the relevant tests in `src/worktree/lock.test.ts`
      and any CLI-level lock-conflict test to assert the new
      message includes the `--factory` reference and the
      clarification.

## 6. Prune deletes branches

- [x] 6.1 In `src/worktree/git.ts`, add
      `gitBranchDelete(repoCwd: string, branch: string, opts?:
      { force?: boolean }): Promise<void>` that shells out to
      `git -C <cwd> branch -D <branch>` (force-delete is the
      desired default per the design doc). On non-zero exit,
      throw a typed error carrying the stderr.
- [x] 6.2 Add tests in `src/worktree/git.test.ts` covering
      successful deletion of an existing branch, and the
      error path when the branch does not exist.
- [x] 6.3 In `src/worktree/prune.ts`, after a directory
      removal succeeds, resolve the branch name in the
      following order:
      (a) query the runs DB for a row matching
          `worktree_path = <dir>`; use its non-null
          `branchName` if present;
      (b) else, if the directory leaf matches `^run-`, infer
          the branch as `run/${leaf.slice("run-".length)}`;
      (c) else (legacy directory naming), do NOT attempt
          branch deletion.
- [x] 6.4 Invoke `gitBranchDelete` for the resolved branch.
      On error, write a stderr warning naming the failing
      directory and branch; do NOT abort the remaining prune
      work. The overall prune exit code SHALL remain `0`
      when the directory removal step succeeded.
- [x] 6.5 Wire the runs DB into `pruneWorktrees` (pass a
      `RunStore` instance through the existing options
      object, optional so the lazy-prune entry point can omit
      it and fall back to directory-name inference only).
- [x] 6.6 Extend `src/worktree/prune.test.ts` with:
      - a regression test that asserts the branch is deleted
        after a worktree is pruned (use a real git fixture as
        the existing tests do);
      - a regression test for the orphan-branch bug: create a
        worktree, run prune, then `minifac run <same-change>`
        succeeds in producing a *new* branch with a different
        slug (the test can stub out the runner and just call
        the worktree-creation step);
      - a test for the `^run-` guard: a legacy-named
        directory is removed without `git branch -D` being
        invoked;
      - a test that `git branch -D` failure is surfaced on
        stderr but does not abort prune.

## 7. `minifac merge` subcommand

- [x] 7.1 Create `src/cli/merge.ts` with the exported
      function (e.g. `runMerge(opts: { arg: string; ffOnly?:
      boolean; pick?: boolean; force?: boolean; store:
      RunStore; cwd: string; stdin: NodeJS.ReadableStream;
      stdout: NodeJS.WritableStream; stderr:
      NodeJS.WritableStream; }): Promise<number>`).
- [x] 7.2 Implement resolution:
      - if `arg` is hex of length ≥ 6: query `listRuns({})`
        and filter by `id.startsWith(arg)`. Single match →
        use it. Multiple matches → usage error listing ids.
      - else: treat as `change` and query for
        `change = arg`. Filter to `status = "succeeded"`
        unless `force`. Single match → use it. Zero → error.
        Multiple → if `pick`, drive the prompt; else, error
        listing candidates.
- [x] 7.3 Implement the `--pick` prompt: write a numbered
      list to `stdout`, read one line from `stdin`. Parse as
      `1..N`. Empty line / EOF → exit `1`.
- [x] 7.4 Refuse rows with `branchName == null` with the
      documented stderr message.
- [x] 7.5 Implement the merge sequence:
      - detect default branch using the existing
        `gitDefaultBranch` helper;
      - verify clean working tree (`git status --porcelain`);
      - `git checkout <default>` (skip if already on it);
      - `git merge --ff-only <branchName>`;
      - if `ffOnly` and step fails → exit `1` with stderr;
      - else fall back to `git merge --no-ff -m "Merge
        <branchName>" <branchName>`;
      - on conflict, `git merge --abort` and list conflicting
        paths via `git diff --name-only --diff-filter=U`.
- [x] 7.6 On success, print a one-line stdout summary naming
      the merged branch and the resulting HEAD SHA. Return
      `0`.
- [x] 7.7 Wire `merge` into the CLI's command dispatcher
      (`src/cli.ts`).
- [x] 7.8 Add `src/cli/merge.test.ts` with at minimum:
      resolve by change with one succeeded run fast-forwards;
      resolve by change with multiple succeeded runs is
      refused without `--pick`; resolve by change with
      multiple succeeded runs + `--pick + "2"` selects the
      second; resolve by run-id prefix; ambiguous run-id
      prefix is a usage error; non-succeeded run is refused
      without `--force`; `--force` allows non-succeeded run;
      merge with conflicts aborts cleanly and lists
      conflicting paths; `--ff-only` refuses fallback; dirty
      working tree refuses with `git stash` hint;
      `branchName == null` is refused with the documented
      message; merge does NOT delete the branch.

## 8. `minifac runs` surfaces `branchName`

- [x] 8.1 Update `src/cli/runs.ts`'s human-table renderer to
      include a `branch` column. `null` renders as the empty
      string or `-`. The column MAY be abbreviated to the
      slug suffix in tight terminals; the JSON output keeps
      the full value.
- [x] 8.2 Update the `--json` projection to include the full
      `branchName` field per row (emitting `null` as JSON
      `null`).
- [x] 8.3 Extend `src/cli/runs.test.ts` to:
      assert the `branch` column appears with non-null and
      null values; assert the `--json` output includes the
      `branchName` field per row.

## 9. Documentation refresh

- [x] 9.1 Update `docs/concepts/Worktree.md` to describe the
      new directory naming (`run-<change>-<slug>`) and the
      retries-don't-collide property.
- [x] 9.2 Update `docs/concepts/Run.md` to describe
      `branch_name` and the per-run branch identity. Add a
      short note about how to find the branch for a given
      run (via `minifac runs` or `minifac runs show <id>`).
- [x] 9.3 Update `examples/sdd.md` to teach `minifac merge
      <change>` as the ship-this-run verb. Show the
      `minifac runs --change <change>` row including the
      branch.
- [x] 9.4 Update `README.md`'s "Run the example" section to
      mention `minifac merge`. Keep the worktree-by-default
      and `--in-place` paragraphs from the prior change
      intact.
- [x] 9.5 Remove the "Prune leaves orphaned branches behind"
      entry from `docs/Open-Questions.md` (resolved by this
      change). Add a brief mention in the entry's place that
      the resolution is the `prune deletes branches it owns`
      requirement of the `worktree-management` capability
      (or remove the entry entirely if the file's convention
      is to leave only open items).

## 10. Validation

- [x] 10.1 Run `openspec validate run-scoped-branches
       --strict` (or the default) and address any reported
       issues until exit is `0`.
- [x] 10.2 Run the full project test suite (`npm test` /
       `vitest`) and confirm every pre-existing test still
       passes alongside the new tests added under tasks 1–8.
