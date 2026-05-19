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

- `minifac serve` — daemon that watches `.minifac/` for factory YAML, exposes a
  local web UI for running factories and streaming agent output
- `minifac run <factory>` — kick off a run from the CLI
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
