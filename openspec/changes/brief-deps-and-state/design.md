## Context

Decision [`0015-Brief-Deps-and-State`](../../../docs/decisions/0015-Brief-Deps-and-State.md)
pins the shape; this document pins how it lands inside the current
codebase.

Current state at the time of this proposal:

- `src/brief/schema.ts` defines `BriefFrontmatterSchema` as a strict
  zod object with `passthrough` for unknown extras (so the loader
  has been silently accepting `depends_on` keys verbatim, just
  un-typed).
- `src/brief/loader.ts` parses brief files and returns a typed
  `Brief = { frontmatter, body, sourcePath }`.
- `src/storage/run-store.ts` exposes `RunStore` with `listRuns({
  change?, status?, limit?, offset? })`. The `branch_name` column
  shipped in [`0019-Run-Scoped-Branches`](../../../docs/decisions/0019-Run-Scoped-Branches.md);
  every row written after that change has the column populated.
- `src/cli/resolve.ts` resolves `<thing>` to a brief or factory and
  is the entry point for the `run` action. Worktree creation and
  runs.db `createRun` happen there (or are reachable from there).
- `src/runner/run.ts` is the graph runner. Terminal-success is
  observed inside it; the runner reports back to the CLI which then
  finalizes the run in runs.db.
- `src/cli/runs.ts` is the existing pattern for "list / filter /
  --json" CLI subcommands; `briefs.ts` should mirror its shape.

Constraints from `CLAUDE.md`:

- No premature subsystems. All new brief logic lives next to the
  existing `src/brief/` directory.
- No anthropomorphic metaphors. Names follow behavior:
  `computeBriefDoneness`, `computeBriefActivity`, `computeBriefState`,
  `BriefCycleError`.
- Snake_case YAML, strict schema with permissive extras.
- No new runtime dependencies.
- TypeScript strict mode; tests next to code.

## Goals / Non-Goals

**Goals:**

- Brief frontmatter explicitly types `depends_on: string[]`
  (default `[]`); the field has always been allowed through
  passthrough, but it now has a contract.
- `computeBriefDoneness` is a pure filesystem check; no git
  invocations.
- `computeBriefActivity` is a single `listRuns({ change, limit: 1 })`
  call; no joins, no second query.
- `computeBriefState` composes the two axes, traverses
  `depends_on` recursively against the filesystem (not runs.db),
  detects cycles, and exposes `blocked` + `blockedReason`.
- The runner refuses blocked briefs early — before worktree
  creation, before lockfile claim — so refusals are cheap and
  observable.
- The mark-done post-step is a contract on minifac, not on
  factories. Factory authors do not need to know it exists; the
  SDD archive node continues doing its archive work unchanged.
- `minifac briefs` is observably stable: `--json` shape is
  documented in the spec and tested.

**Non-Goals:**

- No background watcher / daemon-side polling of brief state. The
  CLI is request-response.
- No caching of `computeBriefState` across invocations. It is
  cheap; the inputs (filesystem + runs.db) are the truth.
- No "ready" derivation in runs.db (e.g. a materialized view).
  `--ready` is a composition of the two axes plus dep traversal,
  computed at call time.
- No new HTTP surface in the serve daemon. Brief state in the
  viewer is a later proposal.

## Decisions

### `depends_on` typed as `string[]` with `[]` default

The zod schema becomes:

```ts
export const BriefFrontmatterSchema = z
  .object({
    change: z.string().min(1),
    factory: z.string().min(1),
    base_branch: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.literal("in-place").optional(),
    depends_on: z.array(z.string().min(1)).optional().default([]),
  })
  .passthrough();
```

- Optional with `.default([])` so existing briefs without the field
  parse cleanly and downstream code sees an array, not undefined.
- Non-empty strings only — the empty string is never a valid change
  name.
- Permissive on other extras stays in force.

### Doneness derivation lives in `src/brief/doneness.ts`

```ts
export type Doneness = "active" | "done" | "missing";

export function computeBriefDoneness(
  change: string,
  opts: { inputsDir: string; repoRoot: string },
): { doneness: Doneness; filePath?: string };
```

- `inputsDir` defaults to `path.join(repoRoot, "inputs")` upstream.
- Resolution order: `<inputsDir>/<change>.md` (active),
  `<inputsDir>/done/<change>.md` (done), else `missing`.
- Pure filesystem check via `fs.existsSync`. No git plumbing.

### Activity derivation lives in `src/brief/activity.ts`

```ts
export type Activity = "none" | "running" | "succeeded" | "failed";

export async function computeBriefActivity(
  change: string,
  opts: { runStore: RunStore },
): Promise<{
  activity: Activity;
  mostRecentRunId?: string;
  branchName?: string;
  endedAt?: number;
}>;
```

- Implementation: `runStore.listRuns({ change, limit: 1 })`. The
  existing list query is sorted by `startedAt DESC`, so the first
  row is the most recent.
- Map the row's `status` to one of `running / succeeded / failed`;
  return `none` (and no run id) when no row exists.

### Combined state lives in `src/brief/state.ts`

```ts
export class BriefCycleError extends Error {
  constructor(public readonly cycle: string[]) { ... }
}

export interface BriefStateResolution {
  doneness: Doneness;
  activity: Activity;
  deps: Array<{ change: string; doneness: Doneness }>;
  blocked: boolean;
  blockedReason?: string;
}

export async function computeBriefState(
  change: string,
  opts: {
    inputsDir: string;
    repoRoot: string;
    runStore: RunStore;
    loadBrief?: (change: string) => Promise<Brief>;
  },
): Promise<BriefStateResolution>;
```

- Algorithm:
  1. Load the brief; read `depends_on`. If the brief is missing,
     return a result whose `doneness = "missing"` and `blocked =
     true` with reason `"brief file not found"`. (Dep traversal of
     a missing brief reports `doneness: "missing"` for the dep
     itself.)
  2. For each declared dep name, compute the dep's doneness via
     `computeBriefDoneness`. A dep with doneness `"done"` is
     satisfied; anything else is unsatisfied.
  3. Cycle detection: walk `depends_on` recursively, maintaining a
     visited set seeded with the root change. If the walk re-enters
     a name on the current path, throw `BriefCycleError` with the
     full cycle for diagnostics.
  4. Compute the root's `doneness` and `activity` (independent
     axes), set `blocked = deps.some(d => d.doneness !== "done")`,
     and set `blockedReason` to a one-line summary naming
     unsatisfied deps.
- Recursive traversal exists so a deep dep chain is diagnosed
  correctly (a brief whose immediate dep is `done` but whose
  transitive dep is `active` is *not* blocked — the immediate dep
  carries the contract). But cycle detection traverses the whole
  graph regardless.

### Runner refuses blocked briefs before worktree creation

The refusal happens in `src/cli/resolve.ts` (or wherever the brief
is resolved before the runner starts):

1. Resolve the brief.
2. Call `computeBriefState(change, ...)`.
3. If `state.blocked` and the user did not pass `--force`, write a
   stderr message naming each unsatisfied dep and its current
   doneness, then exit non-zero. No lockfile, no worktree.
4. If `--force`, log a single stderr warning naming the overridden
   deps and proceed.

Exit code reuses the existing usage-error code (`1`).

### Mark-done post-step lives in the runner

The runner observes terminal-success, then, before reporting the
final status to the CLI:

1. If the brief frontmatter has no `change`, skip (defensive — every
   brief has a change today).
2. Resolve the brief's path inside the worktree:
   `<runCwd>/inputs/<change>.md`.
3. If the source file is already missing AND
   `<runCwd>/inputs/done/<change>.md` already exists, treat as
   idempotent and skip (no warning).
4. Else: ensure `<runCwd>/inputs/done/` exists; run `git -C
   <runCwd> mv inputs/<change>.md inputs/done/<change>.md`; then
   run `git -C <runCwd> commit -m "Mark <change> done"`.
5. If any of the above shells out to non-zero, log a warning
   surfacing the git stderr and continue. The run is still
   recorded as `succeeded`.

The runner does this work itself (not the CLI) so the contract
holds across any entry point that drives a factory to terminal
success.

### `minifac briefs` mechanics

`src/cli/briefs.ts` parses flags, enumerates active and done
briefs from the filesystem, then for each computes state and
emits either a table or a JSON array.

Enumeration:

- Scan `<inputsDir>/*.md` for the active set.
- Scan `<inputsDir>/done/*.md` for the done set.
- Construct the union; for each, load the brief (best-effort —
  a failing parse is reported as a `parse_error` activity but
  does not abort the whole listing).

Filters:

- `--state <s>`: drop rows whose `doneness !== s`.
- `--activity <s>`: drop rows whose `activity !== s`.
- `--ready`: keep rows with `doneness === "active"`, `activity ∈
  {none, failed}` (no in-flight or recently-succeeded run), and
  all deps `done`.

Output:

- Default table columns: `change`, `state`, `activity`,
  `deps_summary` (e.g. `2/3 done` or `—` when no deps),
  `last_run` (id-prefix + branch + ended-at when present, else
  `—`).
- `--json`: a stable array of objects with the fields above plus
  `deps: Array<{ change, doneness }>`, sorted by `change` ascending
  for determinism.

### Open vs closed: when to refuse vs when to warn

| Situation                             | Behavior                                              |
|---------------------------------------|-------------------------------------------------------|
| Brief has unsatisfied dep             | Refuse run (`exit 1`); `--force` overrides            |
| `depends_on` references missing brief | Refuse run; dep listed with `doneness: missing`       |
| `depends_on` contains a cycle         | Refuse run; surface the full cycle                    |
| Mark-done `git mv` fails              | Warn (single stderr line), still record `succeeded`   |
| Mark-done `git commit` fails          | Warn, still record `succeeded`                        |
| Brief already moved to `inputs/done/` | Idempotent skip — no warning                          |
| `--force` with unsatisfied deps       | Warn, proceed                                         |

## Alternatives considered

- **Storing doneness in runs.db** (a `done_at` column or a `done`
  table). Rejected — collaborator A merging would not propagate to
  collaborator B's machine without a sync ceremony; "done" needs
  to be team-visible, which git already provides.
- **Storing doneness in brief frontmatter** (`completed: <date>`).
  Rejected — mutating the brief file conflicts with "the brief is
  the original ask," and is less explicit than directory location.
- **Letting each factory move the brief to `inputs/done/`** (i.e.
  pushing the contract into factory authoring). Rejected — every
  factory would need to implement it; easy to forget; the move is
  a minifac-level assertion of brief completion, not factory work.
- **Caching state in a sidecar file** (e.g. `.minifac/briefs.json`).
  Rejected — adds a sync surface; the truth lives in two places
  already (filesystem + runs.db); caching introduces drift.
- **Background daemon recomputing state**. Rejected — the CLI
  computes state on demand; the cost is dominated by the
  filesystem scan, which is already cheap.
- **Failing the run when mark-done fails**. Rejected — the factory
  work succeeded; the post-step is bookkeeping. Surfacing the
  warning lets the user `git mv` manually and keeps the run's
  outcome accurate.

## Risks / Trade-offs

- **A user `git mv`s a brief to `inputs/done/` while a run on the
  same brief is in flight.** The activity check (most recent row in
  runs.db) is unaffected; the brief's `doneness` becomes `done`
  immediately. The mark-done post-step will see the file already
  in `inputs/done/` and idempotent-skip. Effect: harmless.
- **Two machines run the same brief concurrently.** The lockfile
  (keyed on `(repo-hash, change)`) already serializes per-machine.
  Across machines, both could succeed; the second to finish would
  see the brief already in `inputs/done/` and idempotent-skip the
  move. Their respective commits would be on different run-scoped
  branches.
- **`depends_on` references a brief in a different repo.** Out of
  scope by design — `depends_on` is a same-repo concept until
  cross-repo factory composition exists.
- **Cycle through a `depends_on` chain that crosses a missing
  brief.** Detected; the cycle error surfaces every name on the
  visited path.

## Migration notes

- Existing briefs without `depends_on` parse cleanly: the schema's
  default `[]` covers them.
- Existing briefs whose body already references `depends_on` via
  passthrough get *upgraded* — the field is now typed and
  validated. This is a stricter check; any existing brief whose
  `depends_on` value is not an array of non-empty strings will fail
  to load. The change set ships with the field documented in
  `examples/sample-brief.md` so the typed shape is canonical.
- Existing runs in runs.db do not need migration: every column the
  activity query reads (`change`, `status`, `started_at`,
  `branch_name`) already exists post-0019.
