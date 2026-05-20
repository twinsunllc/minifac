## Context

Decisions [`0009-Worktree-Default`](../../../docs/decisions/0009-Worktree-Default.md)
and
[`0010-Worktree-Cleanup-Hybrid`](../../../docs/decisions/0010-Worktree-Cleanup-Hybrid.md)
specify the *what*. This document pins the *how* against the current
codebase.

Current state:

- `src/cli.ts` wires `minifac run <thing>` → `resolveRunTarget` →
  `loadBrief`/`loadFactory` → `runFactory(factory, { brief, … })`.
- `src/runner/run.ts` walks the graph, builds a per-node `RunContext`,
  dispatches each node to its executor, and accumulates run-wide
  history. It substitutes `{{ brief.* }}` tokens in `with.prompt`
  before dispatch.
- `src/runner/substitute.ts` is a single function taking a prompt
  string and a `Brief`. The token regex is local to the file.
- `src/brief/` carries the brief schema/loader; `src/factory/` carries
  the factory schema/loader. Tests live next to code.
- Examples in `examples/` hard-code `/path/to/target/repo` as each
  node's `cwd`; the operator hand-edits a copy per change. This
  proposal eliminates that copy.

Constraints from `CLAUDE.md`:

- One new directory next to existing ones, not a new package.
- No anthropomorphic naming. Names follow behavior:
  `worktree`, `claimLock`, `pruneWorktrees`, `runJournal`.
- Snake_case YAML, strict schema with permissive extras documented.
- No new runtime dependencies. Git is shelled out via
  `child_process` (existing pattern). Config YAML uses the existing
  `yaml` package.
- TypeScript strict mode; tests beside code.

## Goals / Non-Goals

**Goals:**

- A `minifac run <brief>` invocation creates and uses a worktree
  without any operator pre-step, and the resulting branch lives until
  the operator decides what to do with it.
- The same change-name cannot run twice concurrently; the second
  invocation fails fast at lock-claim time with a clear message.
- `examples/sdd.yaml` ships with `cwd: "{{ run.cwd }}"` and is
  directly runnable through `minifac run <brief>` against any
  OpenSpec repo, without copy-and-edit.
- `minifac prune` makes "I forgot about it, the branch is in,
  reclaim my disk" a single command and never deletes unmerged or
  failed runs unprompted.
- `--in-place` (and brief `mode: in-place`) preserve the CI / read-only
  path: no worktree, no branch, factory runs in `process.cwd()`.
- All existing tests stay green; new tests cover the new surface.

**Non-Goals:**

- No SQLite/Dolt runs.db. The transitional `failed-runs.json` is
  load-bearing for the prune policy but ships with an explicit
  "phase-3 replaces this" note. (Decision 0014 area; not opened here.)
- No factory composition (`extends:`); the per-change YAML copy is
  killed by `{{ run.cwd }}`, not by composition.
- No brief-authoring helper. Brief authoring stays manual.
- No daemon HTTP changes. The serve daemon already exists; it may
  later surface worktree state, but this change does not add that
  surface.
- No new executors. Worktree management lives entirely in the CLI →
  runner seam; executors see a resolved `cwd` string, same as today.
- No reserved tokens beyond `{{ brief.* }}` and `{{ run.* }}`.
  `{{ env.* }}`, `{{ now }}`, etc. are out of scope.

## Decisions

### Decision: One new directory `src/worktree/`, not a new package

All worktree machinery lives under `src/worktree/`. The directory has
six modules — `config.ts`, `paths.ts`, `lock.ts`, `git.ts`,
`journal.ts`, `prune.ts` — each with its own `*.test.ts` neighbor.

**Why not split into `src/worktree/`, `src/lock/`, `src/git/`:** all
six modules service one user — the CLI's `run` and `prune` actions.
Splitting them across directories implies an internal API boundary
that doesn't exist; everything in here is "machinery for minifac's
own worktree lifecycle." If a real second consumer arrives (e.g. the
daemon needs to enumerate worktrees), the directory can grow without
shuffling.

**Why six files and not one:** `lock.ts` and `git.ts` are
process-level side effects that benefit from isolated unit tests
(the lock tests fork child processes; the git tests shell out to
real `git` in a fixture repo). `prune.ts` is policy on top of those
primitives — easier to test in isolation than as one mega-module.

### Decision: Worktree key derivation

For brief-driven runs: `<repo-hash>-<brief.change>`.

For brief-less factory runs: `<repo-hash>-<factory.name>-<timestamp>`,
where `timestamp` is `Date.now().toString(36)` (≤8 chars, lexicographic
sort). The factory name is the value of the factory file's top-level
`name:` field, not the file's basename.

`repo-hash` is the first 8 hex chars of `sha256(repo-identity)`
where `repo-identity` is:

1. `git config --get remote.origin.url` output, trimmed — *if non-empty*
2. else the absolute path of the repo root (`git rev-parse --show-toplevel`)

The remote-URL branch makes two checkouts of the same repo (e.g. a
laptop checkout and a CI checkout) collide on purpose: they share a
worktree directory in `~/.minifac/`. The absolute-path branch is the
fallback for repos with no remote. Eight hex chars yields ~16M
distinct repos before birthday collisions become realistic — adequate
for v0.

**Why include the `<change>` (or `<factory>-<timestamp>`) suffix in the
directory name and not just the hash:** the directory is browsable;
a human inspecting `~/.minifac/worktrees/` should immediately see
which run a directory belongs to. The hash prefix only disambiguates
across repos.

**Why a timestamp instead of a counter for brief-less runs:**
collision-free without consulting any global state. The lockfile
catches the (vanishingly unlikely) sub-millisecond collision on the
same machine.

### Decision: Lockfile is a PID-bearing file, not flock(2)

Each lock is `~/.minifac/locks/<key>.lock`, where `<key>` is the same
suffix used for the worktree directory. The file content is the
owning PID as a decimal string plus a trailing newline.

Claim algorithm:

1. Try `open(path, O_CREAT|O_EXCL|O_WRONLY)`. If it succeeds, write the
   PID, close, return success.
2. If `EEXIST`, read the existing PID. If parsing fails or the PID is
   `<=0`, treat as stale → atomically replace via temp-file rename and
   return success.
3. Send `signal(0)` to the owning PID. If it returns `ESRCH` (no such
   process) or `EPERM` on Unix with PID not belonging to caller —
   treat as live (conservative). Note: on the conservative branch, we
   *don't* claim. The user gets the same "another run is in progress"
   error.
4. Otherwise, the lock is live → claim fails with a clear error
   message naming the holding PID and the lockfile path.

Release: best-effort `unlink(path)` in a `try/finally`. On crash, the
stale-detection branch on the next run cleans up.

**Why not `flock(2)`:** Node has no portable, ergonomic `flock`
binding without a native dep. PID-bearing files cover the same
contract for our process model — single owner, refuse on conflict,
self-heal on crash — without adding `proper-lockfile` or similar.
The race window between PID check and atomic rename is acceptable:
two minifac processes claiming the same key concurrently means the
user typed the same command twice in the same millisecond, which is
its own problem.

**Why `O_EXCL` open instead of "check then write":** the kernel
guarantees atomicity. The check-then-write race window is exactly
what `O_EXCL` exists to close.

### Decision: Worktree creation is `git worktree add -b <branch> <dir> <base>`

The CLI shells out to `git -C <caller-cwd> worktree add -b <change>
<resolved-worktree-dir> <base_branch_or_HEAD>`. The base branch comes
from `brief.frontmatter.base_branch`; when absent, we resolve the
caller's HEAD via `git rev-parse HEAD` and pass the SHA (not the
symbolic name, to avoid attaching the new branch to whatever HEAD
moves to mid-run).

If `git worktree add` exits non-zero (e.g. the branch already exists
from a prior run that wasn't cleaned up), the CLI surfaces the git
stderr verbatim and exits 1. The lock is released in the `finally`
block; no partial state is left in `~/.minifac/`.

**Why not `git worktree add --detach` then create the branch
separately:** `-b` is one syscall fewer and gives git the chance to
fail fast if the branch already exists. The atomicity is helpful.

**Why pin to the resolved SHA when falling back to HEAD:** the user's
HEAD might move while the factory runs (they switch branches in
their main checkout). Pinning to the SHA at claim time isolates the
worktree from that movement.

### Decision: `{{ run.cwd }}` is a second token namespace, not a brief alias

The substitution function grows from "given a Brief, replace
`{{ brief.* }}`" to "given a `Substitutions` record, replace
`{{ <ns>.<field> }}`". The record is:

```ts
type Substitutions = {
  brief?: Brief;     // existing
  run?: { cwd: string };  // new — present whenever the runner has a cwd
};
```

The token grammar widens to:
`/\{\{\s*(brief|run)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g`. Unknown
namespaces or unknown identifiers within a known namespace pass
through verbatim. The existing brief-side semantics are preserved
byte-for-byte (the regex already matched `brief.foo`; now it also
matches `run.foo`).

**Why a record and not two separate function parameters:** future
namespaces (`env`, `now`) slot in as one more field on the record
without changing every call site. The signature stays small.

**Why only `cwd` under `run.*` today and not `run.id`, `run.timestamp`,
etc.:** YAGNI. The single use case is the cwd. When a second field is
needed (likely for daemon URLs), it joins the record then.

### Decision: Substitution applies to `cwd` AND `with.prompt`

`src/runner/run.ts` calls the substitution pass over each scheduled
node's `cwd` field in addition to `with.prompt`. Order of operations
per node, before dispatching to the executor:

1. If `node.cwd` is a non-empty string, run substitution on it.
   The result MAY contain literal tokens (unknown ns/field); the
   executor sees that string as-is and is responsible for treating it
   like any other cwd. This matches today's pass-through-on-unknown
   contract.
2. After substitution, if the resulting `cwd` is the empty string OR
   the node had no `cwd` field at all, fall back to the run-level
   `runCwd` (the resolved worktree path, or `process.cwd()` under
   `--in-place`).
3. If both 1 and 2 yield empty strings (run-less invocation in tests,
   say), pass `undefined` to the executor — same behavior as today.
4. If `node.with` is an object with a string `prompt`, substitute
   over the prompt.

**Why default-fall-back instead of unconditionally overriding
factory `cwd`:** a factory author who explicitly wants a node to run
in a separate directory (e.g. a `prepare` node that touches a
sibling repo) should be able to set `cwd:` literally and have it
honored. The token system gives them `{{ run.cwd }}` when they want
the default and a literal path when they don't.

**Why apply substitution to literal cwd values too (and not only
template-form):** consistency. The substitution pass is a no-op on
strings without tokens, so the cost is zero and the rule is simple:
"all strings in `cwd` and `with.prompt` go through substitution."

### Decision: CLI sequencing

The `run` subcommand grows in front of `runFactory`:

```
1. resolve <thing> → brief|factory  (unchanged)
2. determine mode:  in-place if --in-place OR brief.frontmatter.mode === "in-place"
3. if NOT in-place:
   a. load config (global ~/.minifac/config.yaml + per-repo .minifac/config.yaml, latter wins)
   b. lazy-prune (millisecond-budgeted; on overrun, skip + log nothing)
   c. claim lock by key (brief.change OR factory.name + timestamp)
   d. create worktree (via git worktree add)
   e. set runCwd = worktree path
4. if in-place:
   a. claim lock by key (same scheme; same refuse-on-conflict behavior)
   b. set runCwd = process.cwd()
5. invoke runFactory(factory, { brief, runCwd })
6. on run end (success OR failure):
   a. if status !== "succeeded": append to ~/.minifac/failed-runs.json with the worktree dir
   b. release lock (try/finally; unlink, ignore ENOENT)
   c. emit a final stderr line naming the worktree directory and the run status,
      so the operator knows where to look
```

The worktree directory is NOT deleted on failure (debug value). It is
also not deleted on success — the user reviews and merges from there.
The `prune` subcommand is the only path that deletes worktrees.

**Why claim a lock even under `--in-place`:** the user is asserting
"this is the canonical run of change X right now"; two simultaneous
in-place runs against the same change name still corrupt each other.
The lockfile path is the same `<key>.lock` regardless of mode.

**Why journal failures even though the next phase replaces the
journal:** the prune policy needs to know "is this worktree from a
failed run?" without re-reading the run's logs. The transitional
JSON file is six lines of code and earns the prune policy its day.

### Decision: `failed-runs.json` shape

```json
{
  "entries": [
    {
      "worktreeDir": "/Users/x/.minifac/worktrees/abcd1234-foo",
      "status": "failed",
      "endedAt": "2026-05-19T22:30:00.000Z",
      "reason": "verify budget exhausted"
    }
  ]
}
```

Append-only. The reader treats the file as the source of truth for
"is worktree X a failed run?" — keyed by `worktreeDir`. If a future
run reuses a directory name (won't happen under v0 keying, but is
possible under brief-less factory runs over long time spans), the
*latest* entry for that directory wins (last-write-wins).

The file may be missing — treat as empty. The file may be unreadable
JSON — treat as empty, log a warning to stderr (don't crash the run
that's trying to journal). Concurrency is light (failed runs are
infrequent, lock-protected by the per-key lock); we accept the
write-skew window. The phase-3 runs.db closes the window.

**Why an explicit `entries` array instead of a top-level array:**
forward compat. If the journal needs a top-level version field or
checksum, adding it doesn't require rewriting the consumer.

### Decision: Prune policy implementation

`pruneWorktrees(opts)` walks `~/.minifac/worktrees/`, computes per-dir
classification, and removes directories that match. Classification is:

```
classify(dir) =
  if hasEntryIn(failed-runs.json, dir).status !== "succeeded":  "failed"
  elif age(dir) < 7d:                                            "fresh"
  elif branchMergedTo(default, dir):                             "merged-old"
  else:                                                          "unmerged-old"
```

`age(dir)` is `Date.now() - dir.mtime`. `mtime` is set when the
worktree is created and not refreshed afterward, so it tracks the
worktree's *start* age, not "last touched."

`branchMergedTo(default, dir)`:

1. Determine the branch name from the worktree's
   `.git/HEAD` (or `git -C <dir> branch --show-current`).
2. Run `git branch --merged <default> --contains <branch-sha>` in the
   *main* checkout (not the worktree); a non-empty match → merged.
3. If step 2 says no, try the squash-merge heuristic:
   `git rev-list <default> ^<branch>` followed by checking whether
   every commit on `<branch>` is "patch-equivalent" to a commit on
   `<default>`. The cheap form: if `git log --pretty=%s <branch>
   ^<default>` is empty AND the branch's tip subject appears in the
   first N commits of `<default>`, treat as merged. (Subject match
   is a heuristic; false positives are unlikely because branch
   names are change-specific.)
4. If the default branch can't be detected (no `origin/HEAD`,
   nothing in config), `branchMergedTo` returns `false` for every
   branch. That degrades the policy to "always keep" — safe.

The user-facing flag matrix:

| Flag | Effect |
|---|---|
| (none) | Auto-policy: prune everything classified as `merged-old`. Keep everything else. |
| `--all` | Prune everything classified as `merged-old`, `unmerged-old`, AND `fresh` (the latter is destructive — confirm before running). |
| `--merged` | Prune `merged-old`. (Same as default in v0; kept for forward compat when defaults change.) |
| `--older-than <duration>` | Override the 7-day cutoff for the `fresh`/`*-old` boundary. Format: `7d`, `12h`, `30m`. |
| `--failed` | ALSO prune anything classified as `failed`. By default `failed` is never pruned. |

Flags compose: `--all --older-than 30d` means "everything `≥ 30d`,
across merged-old / unmerged-old / fresh-but-now-aged-out". `--failed`
adds the failed bucket to whatever was selected.

`pruneWorktrees` removes each selected directory by shelling out to
`git -C <main-checkout> worktree remove --force <dir>` (so git's
internal worktree registry stays consistent) and falls back to
`rm -rf <dir>` plus `git worktree prune` if the registered-worktree
removal fails (e.g. the registry already lost track of it).

The branch is NOT deleted along with the worktree. Deleting branches
risks losing user work; the operator can run `git branch -D
<change>` themselves once they're sure.

**Why default to `--merged` semantics (auto-prune-merged-only) on
the no-flag invocation:** matches `docs/decisions/0010` exactly.
Aggressive deletion is opt-in via `--all`.

### Decision: Lazy cleanup is millisecond-budgeted, best-effort

`lazyPrune()` at the start of `minifac run`:

1. `readdir(~/.minifac/worktrees/)` — fast.
2. For each entry, `lstat` for mtime — fast.
3. For each entry with `age >= 7d`, classify via `failed-runs.json`
   read (cached for the call) and the `merged` check.
4. Track elapsed time; if exceeded ~200ms cumulatively, abort the
   loop silently and rely on explicit `minifac prune`.

The `merged` check is the expensive piece (it forks `git`). For
lazy-prune we use a cheaper variant: only the `git branch --merged`
form (not the rev-list heuristic), and only against entries whose
branch name we can read without forking git (i.e. by reading
`<worktree>/.git/HEAD` directly).

**Why 200ms not 1s:** the user is waiting on `minifac run` to start
streaming. A second of opaque silence at the start is the bad UX
the lazy step is meant to avoid in the first place.

### Decision: Config files are optional, additive, last-write-wins

Global config is `~/.minifac/config.yaml`:

```yaml
worktrees_dir: /path/to/dir   # default: ~/.minifac/worktrees
locks_dir: /path/to/dir       # default: ~/.minifac/locks
default_branch: main          # optional; only used by prune
```

Per-repo config is `<repo-root>/.minifac/config.yaml`. Only
`worktrees_dir` is honored here (locks are machine-state, not
repo-state). When both files declare `worktrees_dir`, the per-repo
value wins.

Missing files are not an error. A malformed file is an error
(named, with line/col when available); we exit 1 before touching
the worktrees directory. This matches the factory/brief loaders'
behavior.

**Why config at all in v0:** the user with a small `~/` partition
needs an escape hatch to point worktrees at a roomier disk. Two
fields, both optional, covers it without inviting feature creep.

### Decision: `--in-place` does NOT skip the lock or the journal

In-place mode skips worktree creation and the lazy-prune step. It
STILL claims a lock at `<repo-hash>-<change>.lock` (or the
factory-timestamp variant); a second `--in-place` run against the
same change name is refused with the same message as the
worktree-mode case.

In-place runs also append to `failed-runs.json` on non-success.
The `worktreeDir` field for in-place entries is set to the caller's
cwd (i.e. the repo root). Prune ignores entries whose `worktreeDir`
is not under `~/.minifac/worktrees/`, so the in-place entries are
inert but the record exists for future tooling.

**Why honor the lock under `--in-place`:** see the CLI sequencing
decision above. The lock is the answer to "is something else
running this change right now?", regardless of mode.

### Decision: Brief `mode: "in-place"` is a literal in the schema

`src/brief/schema.ts` gains:

```ts
mode: z.literal("in-place").optional()
```

The only legal literal in v0 is `"in-place"`. Other literals
(`"worktree"`, `"detached"`, …) are rejected. The CLI treats both
`mode: "in-place"` and `--in-place` as setting the same boolean; a
brief with `mode: "in-place"` invoked without `--in-place` runs
in-place. The flag and field don't conflict — they both express the
same intent.

**Why a literal type and not an enum:** there's exactly one value
today. When a second value is needed (unlikely in v0), turning the
literal into a `z.enum(...)` is one mechanical edit and the spec
gets revisited then.

## Risks / Trade-offs

- **[Lockfile races on machine reboot]** → Mitigation: stale-PID
  detection. After a reboot, every lockfile's PID will be either
  reassigned (rare, and our PID would match a wholly unrelated
  process) or absent. The conservative branch ("treat unknown PID
  as live") prefers a false-refuse to a false-claim; the operator
  can `rm ~/.minifac/locks/<key>.lock` and retry. Documented in the
  prune subcommand's `--help`.
- **[Worktree creation failure leaves a dangling lock]** →
  Mitigation: the `try/finally` releases the lock on any error path
  out of the run. Tests cover the happy and the unhappy path.
- **[`git worktree add` semantics differ across git versions]** →
  Mitigation: we shell out to whatever `git` is on `$PATH`; the user
  is responsible for a modern-enough git. Documented in the
  proposal's Impact section and in the prune subcommand's `--help`.
  v0 minimum is `git ≥ 2.5` (worktree support); none of our flags
  require newer.
- **[Squash-merge detection false negatives]** → Mitigation:
  acceptable. A merged-but-not-detected branch is "kept" (the user
  manually prunes if they want to). The opposite mistake — detecting
  a not-actually-merged branch as merged and deleting it — is the
  harmful failure mode, and our heuristic biases the other way.
- **[Transitional `failed-runs.json` becomes load-bearing]** →
  Mitigation: the prune policy reads the journal but the rest of the
  system doesn't depend on its shape. Phase-3's runs.db absorbs the
  journal's responsibility behind the same `pruneWorktrees` API; the
  consumer doesn't change.
- **[`{{ run.cwd }}` token spreads to fields where it shouldn't
  work]** → Mitigation: substitution applies *only* to `cwd` and
  `with.prompt`. Other fields (`executor`, `terminal`, edge
  metadata) are not touched. The spec is explicit about the
  applicable fields.
- **[Operators who routinely run from a non-git directory]** →
  Mitigation: the CLI detects "not a git repo" at lazy-prune time;
  if absent, the worktree path is impossible to create and we fail
  fast with a message naming the issue. `--in-place` still works
  there (no git required) — useful for read-only factories.
- **[Eight hex chars of repo hash isn't a lot]** → Mitigation:
  ~16M before birthday collisions become realistic; if it becomes a
  problem we widen to 12 hex chars without changing the schema
  (the directory naming convention can absorb it). Tests pin the
  current value so a silent widening is intentional.

## Migration Plan

No production data, no users besides minifac developers.

1. Land `src/worktree/` with all six modules and their tests.
2. Extend `src/runner/substitute.ts` to support the `Substitutions`
   record and the `run.*` namespace; update existing call sites and
   the runner to pass the record. Brief-only call sites still work
   (record just has `brief` set).
3. Extend `src/runner/run.ts` to accept `runCwd` and apply it as the
   default node `cwd` after substitution. Pass through to executors
   as today.
4. Extend `src/cli.ts` `run` action with the sequencing above; add
   the `prune` action.
5. Extend `src/brief/schema.ts` with optional `mode: "in-place"`;
   update the brief loader's tests.
6. Migrate `examples/sdd.yaml` to `cwd: "{{ run.cwd }}"`. Delete
   `examples/sdd-worktree-mode.yaml`.
7. Update `docs/concepts/Factory.md` with the templating-tokens
   section. Cross-link `docs/concepts/Worktree.md`.

A pre-change copy of `sdd-<change>.yaml` (if any exists on a
contributor's machine) can be deleted; the new shape doesn't need
it. The brief at `inputs/<change>.md` plus the shipped
`examples/sdd.yaml` is the entire surface.

## Open Questions

- **Should `--in-place` be allowed to claim a lock if the caller is
  CI (no TTY)?** Decision: yes, CI runs deserve the same "don't
  trample yourself" protection as interactive runs. CI authors who
  hit a refuse can `--no-lock` later, if/when that flag exists.
  Out of scope here.
- **Should the lazy-prune step ever surface what it pruned?**
  Decision: no, silently. The operator who wants visibility runs
  `minifac prune` explicitly. The lazy step is meant to be
  invisible.
- **Should brief frontmatter `mode:` accept `"worktree"` as a no-op
  explicit-default value?** Decision: no for v0. The schema rejects
  anything but `"in-place"`. When more modes arrive, the literal
  becomes an enum and `"worktree"` joins.
- **What happens if the configured `worktrees_dir` is on a
  filesystem without atomic `rename`?** Decision: not v0's problem.
  Documented in the `prune` `--help` as a known sharp edge for
  exotic filesystems.
- **Should `prune` ever delete branches alongside worktrees?**
  Decision: no. Branch deletion is irreversible at the local level;
  the operator runs `git branch -D <change>` once they're sure.
- **Should the `failed-runs.json` retain entries indefinitely or
  cap to the last N?** Decision: cap to the last 1000 entries on
  every append (head-trim). The file stays bounded; the policy is
  documented in the journal module.
