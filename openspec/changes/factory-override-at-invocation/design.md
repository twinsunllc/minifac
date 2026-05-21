## Context

Per [[0020-Factory-Override-At-Invocation]], we want to make A/B
factory comparisons natural: `minifac run foo` then `minifac run foo
--factory other`, producing two distinct runs, two distinct
branches, and two distinct rows in `runs.db`. The branch-naming
piece already lands with [[0019-Run-Scoped-Branches]]; what remains
is (a) accepting the CLI flag, (b) routing the override through the
same factory-by-name resolver as today, and (c) widening the
lockfile scope so two A/B invocations against the same brief don't
deadlock each other.

The current shape:

- `run-cli`'s "`minifac run` command" requirement: resolves the
  brief, then resolves the brief's `factory:` through
  `resolveFactoryByName`. The lockfile key for brief-driven runs is
  `<repo-hash>-<change>`.
- `worktree-management`'s "Worktree directory layout and key
  derivation" requirement: the lockfile path uses the per-run key
  and is documented as distinct from the worktree directory key.
- `brief-schema`: `factory:` is required and treated as the
  authoritative factory for the brief.

The change set below preserves every existing scenario for
invocations that do NOT pass `--factory`. The override is purely
additive at the lookup and locking layers.

## Goals / Non-Goals

**Goals:**

- One operator-visible knob (`--factory <name>`) that swaps the
  factory at invocation time. No second concept (no "experiment",
  no per-brief factory list, no per-attempt fork).
- Identical resolution rules for the flag value and the brief's
  `factory:` field. `resolveFactoryByName` is the single source of
  truth for "what file does this name map to."
- Two concurrent A/B runs against the same brief — through
  different factories — proceed in parallel and produce
  independently mergeable branches.
- Two concurrent runs against the same brief through the *same*
  factory still serialize. This is the existing contract and
  remains a load-bearing safety property.
- No schema migration. `runs.db` already records `factory_name`
  and `factory_path`.

**Non-Goals:**

- A `--brief` override on brief-less factory invocations
  (symmetric idea; not in this proposal).
- An automated A/B harness (run brief through N factories, diff,
  recommend). The CLI affordance unlocks the manual A/B; the
  harness can layer on top later.
- Cost-aware A/B (cheap model first, fall back to expensive).
- Studio UI surface for factory comparison.
- `minifac autorun --factory`. Autorun is not yet a landed
  capability; the override will be applied to it when `auto-mode`
  ships. Tracked in `docs/Open-Questions.md`.
- Encoding the factory name in the branch name or worktree
  directory. Per 0020, the slug already discriminates two
  attempts; the factory is in `runs.db` for query.

## Decisions

### 1. Flag shape: `--factory <name>` on `minifac run`

`<name>` accepts the same two forms as the brief's `factory:`:

- `<name>` — try `<cwd>/.minifac/factories/<name>.yaml` first, then
  `<cwd>/examples/<name>.yaml`.
- `minifac:<name>` — skip the local lookup; resolve directly to
  `<cwd>/examples/<name>.yaml`.

**Why not a positional argument?** `minifac run` already takes a
single positional `<thing>` (brief or factory). Adding a second
positional would muddle the resolution table in run-cli's existing
requirement. A named flag is unambiguous and matches the prior art
of `--in-place` and `--force` on the same subcommand.

**Why not extend brief frontmatter to accept an array?** That
would change the brief schema and break the "self-describing brief"
property — the brief would no longer state a single canonical
factory. The override is invocation-time, not brief-time.

### 2. Resolution path: reuse `resolveFactoryByName`

The flag value and the brief's frontmatter field SHALL go through
the same resolver. This guarantees that any future change to the
two-step lookup precedence (per [[0008-File-Per-Factory-Composition]])
applies identically to both code paths and that error messages
("factory not found, tried X and Y") read the same way regardless
of where the name came from.

Error shape on unknown name SHALL match today's brief-field error:
exit `1`, stderr names the offending name and the two paths
attempted (for bare names) or the single path attempted (for the
`minifac:` form).

### 3. Lockfile key widening: `(repo-hash, change, factory)`

The lockfile path for brief-driven runs changes from
`<locks_dir>/<repo-hash>-<change>.lock` to
`<locks_dir>/<repo-hash>-<change>-<factory>.lock`. `<factory>` is
the loaded factory's top-level `name` field (the same value that
ends up in `runs.db.factory_name`).

**Why include `<factory>` in the lockfile but NOT in the branch
name or worktree directory?** The branch and the directory are
already unique per run via the slug ([[0019-Run-Scoped-Branches]]).
The lockfile's job is different: it serializes concurrent
invocations that *should not* both proceed. Two invocations of
`(change=foo, factory=A)` clobber each other if both ran; two
invocations of `(change=foo, factory=A)` and `(change=foo,
factory=B)` are the deliberate A/B case and SHOULD both run.
Encoding `<factory>` in the lockfile expresses exactly this rule.

Brief-less factory keys remain `<repo-hash>-<factory>-<timestamp>`.
That key already includes the factory and is per-invocation by
construction (the timestamp makes every brief-less invocation
distinct), so no widening is needed.

**Stale-lock detection** continues to operate per-key. The
existing PID-bearing claim + zero-signal probe logic is reused
verbatim against the wider key.

### 4. `factory_name` recorded in `runs.db`

No schema change. The run row's `factory_name` column already
captures whichever factory name was resolved at run time
(`brief.factory` today, `--factory` override tomorrow). The change
is purely "pass the override-resolved factory into the same row-
write path."

`minifac runs --change <change>` already surfaces `factory_name` in
both the table view and `--json`. The output formatting is checked
against an A/B scenario (two runs of the same change with
different factories) as part of this change's test plan, but no
schema or column changes are needed.

### 5. Brief schema prose softening

The `factory:` field stays required. The brief is still self-
describing — running `minifac run foo` with no flags produces a
deterministic factory choice from the brief alone. The schema
change is purely prose: the spec now describes `factory:` as the
*default* factory, overridable at invocation time.

**Why keep it required?** A brief with no `factory:` would need
every invocation to pass `--factory`, which loses the "open the
file and know what it runs through" property. Optional briefs
also complicate `minifac briefs --ready` (which factory's lock
status counts?). Keep `factory:` required; let `--factory` be the
override.

## Risks / Trade-offs

- **Risk:** an operator runs `minifac run foo --factory bar` and
  later forgets which factory produced the resulting branch. →
  **Mitigation:** `runs.db.factory_name` records the actual factory
  used; `minifac runs --change foo` shows both attempts side by
  side; `minifac merge` resolves by run id when ambiguous.
- **Risk:** lockfile-key widening creates orphaned `.lock` files
  named under the old key during an in-flight upgrade. →
  **Mitigation:** the lockfile is best-effort cleanup territory
  already (stale detection covers crashes); old-key files left
  behind by a v0 install are harmless and get cleaned up the next
  time someone runs `rm` on the locks directory. No migration
  step needed.
- **Risk:** two A/B runs against the same brief race on
  `inputs/<change>.md` reads or `inputs/done/<change>.md` writes.
  → **Mitigation:** brief reads are idempotent; the `done/`
  rename is performed by whichever run completes first and the
  other run's archive step (if any) will find the file already
  moved. The `done/` semantics already tolerate this race.
- **Trade-off:** the factory name does not appear in branch or
  worktree-dir names. → **Mitigation:** the slug discriminates
  runs and `runs.db` carries the factory column; encoding it in
  the path adds noise to short branch names and offers no value
  the database doesn't already provide.

## Migration Plan

- No schema migration.
- No file format migration.
- Existing briefs continue to run unchanged when `--factory` is
  not supplied.
- In-flight runs with old-key lockfiles are unaffected (they
  release their own lockfile on completion). New runs after the
  upgrade use the wider key by default. Old-key `.lock` files
  with no owner can be removed manually if observed.

## Open Questions

- Should `minifac runs --change <change>` add a column ordering
  that groups by factory when two rows share the same change?
  Likely out of scope here; the existing `startedAt`-descending
  order is fine for v0 of A/B usage.
- Should the autorun flag, when it lands, restrict the override
  to a single factory or accept an array (run every brief through
  every listed factory)? Tracked separately under the `auto-mode`
  change.
