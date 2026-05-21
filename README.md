# minifac

A miniature factory. Directed (possibly cyclic) graphs of agent + tool nodes,
defined in YAML, executed by a small daemon with a live web viewer.

## Why this exists

Scarif and gas-city-style systems have useful ideas — graph-shaped workflows,
streaming agent output, per-repo customization — but they've grown bloated and
metaphor-heavy. minifac is a deliberate restart with three rules:

1. **Small core.** A graph runner, a streaming executor, a viewer. Nothing else
   is "core."
2. **Rational names.** Things are named after what they do. No anthropomorphic
   metaphors, no proprietary jargon.
3. **Spec-driven from day one.** Every behavior change goes through
   propose → apply → verify → archive, using [OpenSpec](https://github.com/Fission-AI/OpenSpec).

## Workflow: SDD (Spec-Driven Development)

minifac is built using SDD, and ships a canonical SDD factory you can run
against any repo:

```
propose ──▶ apply ──▶ verify ──┬──▶ archive
   ▲                            │
   └────── (cycle on failure) ──┘
```

- **propose** — produce a change proposal (design, tasks, spec deltas)
- **apply** — implement the proposed change
- **verify** — run checks; if they fail, route back to propose with feedback
- **archive** — fold the change into the canonical spec

Cycles are bounded; human-in-the-loop gates only engage when the loop budget
is exhausted or a node flags an intractable problem.

## What's in the box (planned v0)

- `minifac run <thing>` — kick off a run from the CLI by brief path,
  brief name (`inputs/<name>.md`), or factory name (`examples/<name>.yaml`)
- `minifac serve [dir]` — local daemon that watches a directory for factory
  YAML, exposes a live web viewer at `http://127.0.0.1:4280` for picking a
  factory, kicking off a run, and tailing node events over SSE
  (localhost-only, no auth)
- Factory schema (YAML): typed nodes, directed edges (cycles allowed),
  per-node executor (`claude` by default; pluggable for codex / opencode / etc.),
  top-level `brief: required | optional | none`
- Brief schema (markdown + YAML frontmatter): per-change input authored
  at `inputs/<change>.md`; substituted into factory prompts via
  `{{ brief.change }}` and `{{ brief.body }}` tokens
- Pluggable storage with [beads](https://github.com/steveyegge/beads) (work items)
  and [Dolt](https://www.dolthub.com/) (run history) as the default impl.
  SQLite-only fallback for environments without either.
- Two example factories:
  - `hello.yaml` — single-node, learn-the-schema example (brief-less)
  - `sdd.yaml` — the propose/apply/verify/archive loop (brief-driven)

## Run the example

```
npm install
npm run build
node dist/cli.js run hello
```

This invokes `examples/hello.yaml` by name. The factory declares
`brief: none`, so no brief is needed. `examples/hello.yaml` defines a
single `claude` node, so the `claude` CLI must be on `$PATH`.

In an interactive terminal `minifac run` opens an inline TUI (status
pane + log pane + hotkey bar — see [`docs/concepts/Run-TUI.md`](docs/concepts/Run-TUI.md)).
For pipes, redirects, and CI it falls back to line-prefixed raw
output. Pass `--raw` to force the raw output even in a TTY (the
form scripts and CI should rely on); `--tui` forces the TUI in a
non-TTY. The run exits with code `0` on success, `1` on
load/validation errors, `2` on node failure, and `3` on budget
exhaustion.

To run the SDD loop on a real change, author a brief and invoke it by
name:

```
# Author inputs/my-change.md (see examples/sample-brief.md for the shape).
node dist/cli.js run my-change
```

The brief can be authored a few ways: walk through the question
schema interactively with `node dist/cli.js brief my-change` (or
`/brief my-change` in Claude Code, which uses the `brief-authoring`
skill), pass `--from answers.yaml` for scripted input, or hand-edit
`inputs/my-change.md` in your editor.

The CLI looks for `inputs/my-change.md`, resolves its `factory:` field
(usually `sdd`) to `examples/sdd.yaml`, creates a fresh git worktree
at `~/.minifac/worktrees/run-my-change-<slug>/` (where `<slug>` is
the first 6 hex chars of the run id), cuts a branch
`run/my-change-<slug>` from `base_branch`, and runs the factory
inside it with the brief in scope. The runner substitutes
`{{ brief.change }}`, `{{ brief.body }}`, and `{{ run.cwd }}` (the
worktree path) into each node's prompt and `cwd` before dispatch.
Ship the result with `minifac merge my-change` (fast-forwards by
default; falls back to a merge commit when the default branch has
advanced). Reclaim disk with `minifac prune` once your branches
have merged; it deletes both the directory and the per-run branch.
See [`examples/sdd.md`](examples/sdd.md) for the full per-node
contract and [`examples/sample-brief.md`](examples/sample-brief.md)
for the brief template.

Pass `--in-place` (or set `mode: in-place` in the brief frontmatter)
to skip worktree creation and run in the current cwd — useful for CI
or read-only factories.

### Dependent briefs

A brief MAY declare `depends_on: [<other-change>]` in its frontmatter
to make another brief's completion a precondition:

```yaml
---
change: api-routes
factory: sdd
depends_on:
  - api-schema
---
```

A dep is satisfied when its file lives in `inputs/done/<name>.md`
(strictly merged, not "the factory ran successfully on this
machine"). `minifac run api-routes` refuses to start while
`inputs/api-schema.md` is still active, naming the unsatisfied dep on
stderr. Pass `--force` to override (cycles are never bypassed). On a
successful brief-driven run, minifac itself runs `git mv
inputs/<change>.md inputs/done/<change>.md` + a commit inside the
worktree so dependents downstream see the dep satisfied as soon as
the run lands. Use `minifac briefs` (or `--ready`) to see what's
queued, blocked, and ready to pick up.

Every run — under `minifac run` or `minifac serve` — is persisted to
`~/.minifac/runs.db` (configurable). List recent runs with `minifac runs`
and replay one with `minifac runs show <id>`; see
[`minifac runs`](#minifac-runs--inspect-history) below.

Alternatively, use `minifac serve` for a live web viewer of the same run
(see the [`minifac serve`](#minifac-serve--web-viewer) section below).

## `minifac serve` — web viewer

`minifac serve` starts a local daemon that watches a directory for
factory YAML files and exposes a small web viewer. It uses the same
loader and runner as `minifac run`, so any factory that runs in the
terminal will run identically under the daemon.

```
node dist/cli.js serve examples/
# minifac serve listening on http://127.0.0.1:4280 (watching examples/)
```

Then open <http://127.0.0.1:4280/> in a browser. You'll see:

- a list of factories discovered in the watched directory,
- the selected factory's graph (nodes + edges, with the verify→apply
  retry edge styled as a back-edge),
- a "Start run" button that POSTs to `/api/runs` and opens a live
  Server-Sent Events stream of node events,
- per-node status indicators that turn green on `succeeded` and red on
  `failed` as the runner reports them.

**Security posture:** the daemon binds `127.0.0.1` by default and
**refuses any non-loopback `--host`**. There is no authentication,
TLS, or audit log. It is intended for single-user local use. If you
need to expose minifac on a network interface, that lives behind a
separate proposal (we'll add auth before we add wider binding).

**v0 scope:** the viewer can list factories, render the graph, start a
run, and tail its events. There is no in-browser YAML editing and no
pause/resume/cancel/retry-from-node controls — each is a future proposal
when justified.

Run state is persisted to `~/.minifac/runs.db` (a SQLite file), so the
viewer's "Recent runs" list survives daemon restarts and prior runs are
replayable in the event-tail pane. Set `runs_db:` in
`~/.minifac/config.yaml` (or in a per-repo `.minifac/config.yaml`) to
move the file elsewhere; `MINIFAC_HOME` overrides the whole machine-state
root.

Flags:

- `--port <number>` (default `4280`)
- `--host <string>` (default `127.0.0.1`; loopback-only)
- positional directory (default `.`)

Point it at `examples/` to dogfood with `hello.yaml` and `sdd.yaml`;
see [examples/sdd.md](examples/sdd.md) for the SDD factory's per-node
contract.

### sdd.yaml — the propose/apply/verify/archive loop

`examples/sdd.yaml` is the canonical SDD factory: four `claude` nodes
wired into the propose → apply → verify → archive loop, with verify
looping back to apply on failure (bounded at three retries). It is
**brief-driven**: you don't edit the YAML per change. Instead:

1. Author a brief at `inputs/<change>.md` with `change:` and
   `factory: sdd` in the frontmatter and the change intent in the
   body. See [examples/sample-brief.md](examples/sample-brief.md).
2. Set every node's `cwd` in `examples/sdd.yaml` to the absolute path
   of the target repo (an OpenSpec-equipped repo with verify commands
   like `npm test`, `npm run build`, `npm run check`).
3. Invoke `node dist/cli.js run <change>`.

See [examples/sdd.md](examples/sdd.md) for the full per-node contract,
the brief-driven workflow, and known friction points.

## `minifac runs` — inspect history

Every run is persisted to `~/.minifac/runs.db` (a SQLite file; the path
is configurable via `runs_db:` in `~/.minifac/config.yaml` or per-repo
`.minifac/config.yaml`). Two read-only subcommands query it from the
terminal:

```
# List the 20 most recent runs (table output).
node dist/cli.js runs

# Filter and emit JSON for piping.
node dist/cli.js runs --factory sdd --status failed --limit 50 --json

# Replay one run's event log (id or unambiguous prefix).
node dist/cli.js runs show <id>

# Tail an in-flight run by polling the store.
node dist/cli.js runs show <id> --follow
```

`runs` exits `0` even when zero runs match, `1` on usage errors (bad
`--status` value, non-positive `--limit`, unknown / ambiguous id), or
on a fatal storage error.

## Contributing / SDD workflow

Every non-trivial change in this repo goes through the OpenSpec workflow:

1. `/opsx:propose "<idea>"` — write the proposal, design, tasks, and any
   spec deltas under `openspec/changes/<change-name>/`.
2. `/opsx:apply <change-name>` — work through the tasks, keep
   `tasks.md` in sync with reality, and run the verify gate (`npm test`,
   `npm run build`, `npm run check`).
3. `/opsx:archive <change-name>` — fold the change into the canonical
   spec under `openspec/specs/`.

Smaller fixes (docs, typos, formatting) can skip the dance; everything
that changes behavior or schema goes through it.

## Status

Pre-zero. The first openspec change proposal defines the v0 architecture.
See `openspec/changes/` for active proposals and `openspec/specs/` for the
canonical spec.

## Workflow commands (Claude Code)

This repo is set up with OpenSpec's Claude Code integration. Use:

- `/opsx:propose "<idea>"` — open a new change proposal
- `/opsx:apply` — implement an approved proposal
- `/opsx:archive` — fold a completed change into the canonical spec
- `/opsx:explore` — explore the current spec and changes
