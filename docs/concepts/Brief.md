---
tags: [concept]
aliases: [briefs, change-brief, input-brief]
---

# Brief

A brief is the per-change input to a [[Factory]]. It captures what to
build for one change; the factory consumes it and produces the change's
proposal / apply / verify / archive artifacts.

## Schema

YAML frontmatter:

| Field | Required | Purpose |
|---|---|---|
| `change` | yes | The change name (kebab-case) |
| `factory` | yes | Default factory reference (`sdd`, `minifac:sdd`, etc.). Overridable at invocation time via `minifac run <brief> --factory <name>` — see [[0020-Factory-Override-At-Invocation]]. |
| `base_branch` | no | Branch to base the [[Worktree]] on (default: caller's HEAD) |
| `model` | no | Per-brief Claude model override (default: factory config) |
| `mode` | no | Literal `"in-place"` to skip worktree creation |
| `depends_on` | no | Names of other briefs whose completion is a precondition |

Loader is **strict on required fields, permissive on unknown extras**.
Future fields (`priority`, `tags`) slot in without schema
migration. See [[0005-Brief-Schema]] and [[0015-Brief-Deps-and-State]].

Body is free-form markdown. The brief-authoring helper produces a
template with recommended sections (Background / What to do /
Out of scope / Acceptance criteria), but the loader does not enforce
them — a one-line body is still a valid brief.

## Where briefs live

`inputs/<change>.md` in the target repo by default. Discovered by
`minifac run` via the lookup precedence in [[0006-Verb-Shape]].

## Lifecycle

A brief lives on two axes, stored in two different places. Together
they answer "what's queued, what's in flight, and what's done" without
duplicating truth.

- **Doneness** is the brief's directory location in git:
  - `inputs/<change>.md` → `active`
  - `inputs/done/<change>.md` → `done`
  - neither → `missing`

  Doneness is team-visible the moment the merge lands. There is no
  per-machine "done" cache; if you can see the file, you see the
  state. Manual completion is a one-liner: `git mv inputs/foo.md
  inputs/done/foo.md`.

- **Activity** is the most recent row for the brief's change in
  [[Runs-DB]]: `none`, `running`, `succeeded`, or `failed`. Activity
  is per-machine and ephemeral; it answers "is there a run in flight
  on this box?" without needing a sync ceremony.

The two axes are independent. A brief whose last run `succeeded` but
whose file is still in `inputs/` is `state: active, activity: succeeded`
— a useful signal that the run landed but the brief has not been
marked done yet.

### `depends_on`

A brief MAY declare `depends_on: [<other-change>, ...]` in its
frontmatter. A dep is *satisfied* when its file is at
`inputs/done/<other-change>.md` (doneness `done`). `minifac run`
refuses to start a brief whose deps are not all satisfied; pass
`--force` to override (cycle detection is not bypassed by `--force`).

### Runner mark-done post-step

The runner is responsible for moving a brief from `inputs/<change>.md`
to `inputs/done/<change>.md` after a brief-driven run terminates with
`succeeded`. The move + commit happen inside the run's worktree (or
in-place cwd) just before the run is recorded as `succeeded` in
runs.db. Failures of `git mv` or `git commit` log a warning but do not
downgrade the run's terminal status — the user can finish the move
manually with one `git mv`.

Factory authors do not need to know any of this exists. The mark-done
step is a minifac-level contract, not a per-factory responsibility.

### Autorun consumption

`minifac autorun` (see [[Auto-Mode]]) polls the inputs directory and
runs ready briefs using the same primitive manual `minifac run`
invocations use. It relies on the mark-done post-step to move
processed briefs from `inputs/` to `inputs/done/`, which removes them
from the next poll's candidate set without further coordination.

### Why the split

See [[0015-Brief-Deps-and-State]] for the rationale: doneness needs
to be team-visible (git is the right substrate), activity is
per-run-history (runs.db is the right substrate), and mixing them
into one storage layer requires either a sync ceremony (collaborator
A merges, collaborator B has to import) or a state coupling between
the two (every dep check has to consult runs.db).

## Authoring

Briefs are authored by humans, with help from two surfaces that
share a single question schema (see [[brief-authoring]]):

- `/brief <name>` in Claude Code — invokes the
  brief-authoring skill, which walks the user one question at a
  time and writes `inputs/<change>.md`.
- `minifac brief <name>` from the terminal — same question flow,
  no LLM. Use `--from <file>` for scripted (YAML/JSON) answers.

The authoring tool is upstream of the factory; once the brief
file exists, the helper exits stage left. Any editor or tool that
produces a conforming file is fine — see
[`examples/sample-brief.md`](../../examples/sample-brief.md) for
the canonical shape.

## Related

- [[Factory]] — what consumes a brief
- [[Run]] — one execution of a (factory, brief) pair
- [[Worktree]] — where the run's work happens
- [[0004-Factory-vs-Input-Separation]]
- [[0005-Brief-Schema]]
- [[0006-Verb-Shape]]
