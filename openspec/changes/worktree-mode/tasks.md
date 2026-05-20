## 1. Worktree machinery (`src/worktree/`)

- [x] 1.1 Create `src/worktree/config.ts`. Export
      `WorktreeConfig` (typed object with `worktreesDir`, `locksDir`,
      `defaultBranch?`) and `loadWorktreeConfig(callerRepoRoot:
      string): Promise<WorktreeConfig>`. Read
      `~/.minifac/config.yaml` and `<callerRepoRoot>/.minifac/config.yaml`
      with the existing `yaml` package; merge with per-repo wins for
      `worktrees_dir` and `default_branch`; ignore per-repo
      `locks_dir`. Missing files are not errors. Malformed YAML
      throws a typed error (`WorktreeConfigError`) with line/col
      where available.
- [x] 1.2 Create `src/worktree/config.test.ts`. Cover: missing files
      → defaults; global-only; per-repo-only; both set → per-repo
      wins for `worktrees_dir`; per-repo `locks_dir` is silently
      ignored; malformed YAML rejected with file path in message.
- [x] 1.3 Create `src/worktree/paths.ts`. Export `computeRepoHash(repoRoot:
      string): Promise<string>` (8 lowercase hex chars from
      `sha256(remoteUrl || repoRoot)`); `worktreeKeyForBrief(repoHash:
      string, change: string)` returning `${repoHash}-${change}`;
      `worktreeKeyForFactory(repoHash, factoryName, timestamp)`
      returning `${repoHash}-${factoryName}-${base36(timestamp)}`;
      `worktreePathForKey(config, key)`; `lockPathForKey(config, key)`.
- [x] 1.4 Create `src/worktree/paths.test.ts`. Cover: same repo root
      yields same hash; different repos yield different hashes;
      timestamp encoding is base36 and bounded ≤ 8 chars for current
      epoch; brief/factory key shapes match the spec.
- [x] 1.5 Create `src/worktree/lock.ts`. Export `claimLock(lockPath:
      string): Promise<{ release: () => Promise<void> }>` and
      `LockHeldError` (carries the holding PID, the resolved key,
      and the lockfile path). Implement claim using
      `fs.open(path, "wx")` (O_CREAT|O_EXCL). On EEXIST, read PID;
      unparseable or `<=0` → atomic temp-write + rename to claim;
      live PID (probe via `process.kill(pid, 0)` returning without
      ESRCH) → throw `LockHeldError`; ESRCH → atomic rename to
      claim. `release` deletes the lockfile, ignoring ENOENT.
- [x] 1.6 Create `src/worktree/lock.test.ts`. Cover: claim from
      empty → file exists with current PID + newline; second claim
      while first held throws `LockHeldError` naming the PID; stale
      PID (use a known-dead PID like `Number.MAX_SAFE_INTEGER` or a
      fork that exits before the claim) reclaims; unparseable file
      contents reclaim; release deletes the file; release after
      external deletion is a no-op.
- [x] 1.7 Create `src/worktree/git.ts`. Wrap the git shell-outs the
      worktree machinery needs: `gitWorktreeAdd(repoCwd, dir,
      branch, baseRev)`, `gitWorktreeRemoveForce(repoCwd, dir)`,
      `gitWorktreePrune(repoCwd)`, `gitRevParseHead(repoCwd)`,
      `gitDefaultBranch(repoCwd, configuredDefault?)` (config →
      `origin/HEAD` → `main`), `gitBranchMerged(repoCwd, branch,
      defaultBranch)` (true if branch is reachable from default
      via `git branch --merged` OR the squash-merge subject
      heuristic), `gitRemoteOriginUrl(repoCwd)`. All shell-outs
      route through `child_process` (no new deps); each function
      returns either a string/boolean or throws a typed error with
      the captured stderr.
- [x] 1.8 Create `src/worktree/git.test.ts`. Set up an isolated git
      fixture under `os.tmpdir()` (init, commit, branch). Cover:
      worktree add succeeds; worktree add against an existing branch
      throws with stderr; remote-url returns the configured value or
      empty; HEAD resolution; branch-merged true after a
      fast-forward merge; branch-merged true via subject heuristic
      after a squash merge; branch-merged false on unmerged branch.
- [x] 1.9 Create `src/worktree/journal.ts`. Export
      `FailedRunEntry` (typed) and
      `appendFailedRun(entry: FailedRunEntry): Promise<void>` plus
      `readFailedRuns(): Promise<FailedRunEntry[]>`. File path is
      `path.join(homedir, ".minifac", "failed-runs.json")`. Append
      trims to the last 1000 entries. Missing file → empty. Unreadable
      JSON → empty (warn once to stderr; don't throw).
- [x] 1.10 Create `src/worktree/journal.test.ts`. Cover: missing file
       reads as empty; append creates file; append trims to 1000;
       unreadable JSON reads as empty with a stderr warning; cap is
       exactly 1000 after extra appends.
- [x] 1.11 Create `src/worktree/prune.ts`. Export
       `classifyWorktree(dir, journalEntries, defaultBranch,
       cutoffDays, gitOps)` returning one of
       `"fresh" | "merged-old" | "unmerged-old" | "failed"`, and
       `pruneWorktrees(opts: { all?: boolean; merged?: boolean;
       olderThan?: { value: number; unit: "m"|"h"|"d" }; failed?:
       boolean; lazy?: boolean; budgetMs?: number; })` that returns
       per-bucket counts. The `lazy: true` path is millisecond-
       budgeted (default 200ms), skips the squash-merge heuristic,
       and silently aborts on overrun. Removal sequence:
       `gitWorktreeRemoveForce` first, fall back to `rm -rf` +
       `gitWorktreePrune`. Branches are NOT deleted.
- [x] 1.12 Create `src/worktree/prune.test.ts`. Cover classification
       edges: 6d23h is fresh; 7d is the boundary into the
       age-eligible buckets; merged-old detection via branch
       --merged; merged-old detection via squash-merge subject
       heuristic; unmerged-old kept by default; failed kept by
       default; default-branch absent → everything `unmerged-old`
       (safe-keep degradation). Flag combinations:
       no-flag prunes merged-old only; `--all` prunes
       fresh+merged-old+unmerged-old but not failed; `--failed`
       alone prunes failed only; `--all --failed` prunes everything;
       `--older-than 30d` shifts the cutoff. Lazy path: 200ms
       budget honored, silent on overrun.

## 2. Brief schema: `mode: "in-place"`

- [x] 2.1 Extend `src/brief/schema.ts` to add
       `mode: z.literal("in-place").optional()` on the
       passthrough frontmatter object. Surface a clear error on any
       non-`"in-place"` value (the existing `loadBrief` ZodError
       handler should already format this, but verify the message
       names the offending value and the supported literal).
- [x] 2.2 Extend `src/brief/loader.test.ts` to cover: `mode:
       "in-place"` parses; `mode: "yolo"` is rejected naming the
       supported literal; absent `mode` parses (unchanged).

## 3. Runner substitution and run-level cwd

- [x] 3.1 Extend `src/runner/substitute.ts`. Replace the brief-only
       signature with a `Substitutions` record (`{ brief?: Brief;
       run?: { cwd: string } }`) and a function
       `substitute(input: string, subs: Substitutions): string`.
       The regex widens to
       `/\{\{\s*(brief|run)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g`.
       Unknown ns or unknown fields under a known ns pass through
       verbatim. Brief field resolution preserves today's
       semantics. `run.cwd` resolves to `subs.run?.cwd` when set;
       any other `run.*` field passes through.
- [x] 3.2 Extend `src/runner/substitute.test.ts`. Cover the new
       cases: `{{ run.cwd }}` substitutes when `run` is set;
       passes through when not; unknown `run.<field>` passes
       through; `brief.*` semantics unchanged (smoke-test
       existing cases).
- [x] 3.3 Extend `src/runner/run.ts`. Accept an optional
       `runCwd: string` on `runFactory`'s options object. For each
       scheduled node, before dispatch:
       (a) build a `Substitutions` record from the run's brief
           and `runCwd`;
       (b) run substitution on `node.with.prompt` (if string) and
           on `node.cwd` (if non-empty string);
       (c) if `node.cwd` resolves to empty/undefined and `runCwd`
           is set, pass `runCwd` to the executor; else pass the
           resolved cwd as today.
- [x] 3.4 Extend `src/runner/run.test.ts`. Cover: literal `cwd`
       takes precedence over `runCwd`; `{{ run.cwd }}` resolves to
       `runCwd`; missing `cwd` falls back to `runCwd`; no
       `runCwd` reproduces today's pass-through behavior; both
       `with.prompt` and `cwd` go through substitution in a single
       run.

## 4. CLI sequencing in `src/cli.ts`

- [x] 4.1 Add a `--in-place` flag to the `run` subcommand parser.
- [x] 4.2 Refactor the `run` action into the documented sequence
       (resolve → mode → config → lazy-prune (worktree mode only)
       → claim lock → create worktree (worktree mode only) →
       invoke runner with `runCwd` → finally(journal if failed +
       release lock + final stderr summary line)). Lock key is
       `<repo-hash>-<change>` for brief-driven, or
       `<repo-hash>-<factory.name>-<timestamp>` for brief-less.
- [x] 4.3 Add a `prune` subcommand. Flags: `--all`, `--merged`,
       `--older-than <duration>`, `--failed`. Parse
       `--older-than` as `<int><m|h|d>`; usage error on a bad
       value. Delegate to `pruneWorktrees`. Print a one-line
       summary; exit 0 on successful processing, even if zero
       removed.
- [x] 4.4 Update `src/cli.test.ts` to cover the new flows. New
       cases: `--in-place` skips worktree creation but claims a
       lock; brief `mode: "in-place"` is equivalent to the flag;
       lock conflict on second concurrent invocation; final
       stderr summary line is present on both success and
       failure; `minifac prune` accepts each flag combination and
       prints the expected summary shape. Where worktree-related
       paths are tested, use a temp-dir based config override (a
       new helper, or environment override of `worktrees_dir` /
       `locks_dir` in tests).
- [x] 4.5 Wire any per-test environment overrides for the home
       directory (so tests don't write to the real
       `~/.minifac/`). Acceptable approach: read
       `MINIFAC_HOME` env var when set in `paths.ts` / `config.ts`
       and use it instead of `os.homedir()`; tests set it to a
       `os.tmpdir()` mkdtemp path.

## 5. Migrate `examples/sdd.yaml` and ship the cwd token

- [x] 5.1 Replace every per-node `cwd: /path/to/target/repo` (or
       similar hand-edited placeholder) in `examples/sdd.yaml`
       with `cwd: "{{ run.cwd }}"`. Verify the YAML loads via
       `loadFactory` after the edit.
- [x] 5.2 Delete `examples/sdd-worktree-mode.yaml` (the
       transitional dogfood copy is obsoleted by `{{ run.cwd }}`).
- [x] 5.3 Update `src/factory/sdd-example.test.ts` structural
       assertions: each node's `cwd === "{{ run.cwd }}"`; no
       node's `cwd` contains `/path/to/target/repo`.

## 6. Documentation

- [x] 6.1 Update `docs/concepts/Factory.md` with a "Templating
       tokens" section that names the recognized namespaces
       (`brief`, `run`), the per-namespace field sets, the target
       fields (`with.prompt`, `cwd`), and the unknown-token
       pass-through rule.
- [x] 6.2 Add a paragraph to `examples/sdd.md` describing the new
       worktree-by-default behavior: `minifac run <brief>` creates
       a worktree, all nodes run there via `{{ run.cwd }}`, the
       branch and worktree live until the operator merges or
       prunes. Reference `minifac prune` for cleanup and
       `--in-place` for the read-only/CI escape hatch.
- [x] 6.3 Update `README.md`'s "Run the example" section to
       mention the worktree-by-default flow and the optional
       `--in-place` opt-out.

## 7. Validation

- [x] 7.1 Run `openspec validate worktree-mode --strict` (or just
       `openspec validate worktree-mode`) and address any issues.
- [x] 7.2 Run the existing project test suite (`npm test` /
       `vitest`) and confirm all pre-existing tests still pass
       alongside the new ones.
