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

- `minifac run <factory>` — kick off a run from the CLI
- `minifac serve [dir]` — local daemon that watches a directory for factory
  YAML, exposes a live web viewer at `http://127.0.0.1:4280` for picking a
  factory, kicking off a run, and tailing node events over SSE
  (localhost-only, no auth)
- Factory schema (YAML): typed nodes, directed edges (cycles allowed),
  per-node executor (`claude` by default; pluggable for codex / opencode / etc.)
- Pluggable storage with [beads](https://github.com/steveyegge/beads) (work items)
  and [Dolt](https://www.dolthub.com/) (run history) as the default impl.
  SQLite-only fallback for environments without either.
- Two example factories:
  - `hello.yaml` — single-node, learn-the-schema example
  - `sdd.yaml` — the propose/apply/verify/archive loop

## Run the example

```
npm install
npm run build
node dist/cli.js run examples/hello.yaml
```

`examples/hello.yaml` defines a single `claude` node, so the `claude` CLI
must be on `$PATH`. Output from each node is streamed to the terminal with
a `[<node_id>]` prefix; the run exits with code `0` on success, `1` on
load/validation errors, `2` on node failure, and `3` on budget exhaustion.

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
run, and tail its events. There is no in-browser YAML editing, no
pause/resume/cancel/retry-from-node controls, and no persistent run
history — closing the daemon discards all run state. Each is a future
proposal when justified.

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
shipped as a **template** — copy it, edit two things, then run:

1. Replace every `<CHANGE_NAME>` in the prompts with the real change
   name.
2. Set every node's `cwd` to the absolute path of the target repo
   (an OpenSpec-equipped repo with verify commands like `npm test`,
   `npm run build`, `npm run check`).

See [examples/sdd.md](examples/sdd.md) for the full per-node contract,
the copy-and-edit workflow, and known friction points.

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
