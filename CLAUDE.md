# CLAUDE.md — minifac

Project-specific guidance for Claude Code working in this repo.

## What this project is

minifac is a small graph-based workflow runner — directed graphs (cycles
allowed) of agent + tool nodes, defined in YAML, executed by a TypeScript
daemon with a live web viewer. See `README.md` for the full pitch.

## How we work here

**This repo uses Spec-Driven Development.** Every non-trivial change goes
through OpenSpec:

1. `/opsx:propose "<idea>"` — write the proposal, design, tasks, spec deltas
2. `/opsx:apply` — implement the tasks
3. verify — run the checks
4. `/opsx:archive` — fold spec deltas into canonical spec

If a user asks you to change behavior, **start with `/opsx:propose`** unless
they explicitly say "skip the spec dance" or the change is purely
docs/typos/formatting. The point of minifac is to dogfood SDD; bypassing it
defeats the purpose.

## Anti-goals (do not reintroduce)

- **No anthropomorphic metaphors** in code, file names, or docs. A node is a
  node, not a "worker," "agent persona," "citizen," etc. Things are named
  after what they do.
- **No premature subsystems.** Scarif grew to a half-dozen packages. minifac
  is one package until it has earned the right to split.
- **No untyped runner registries / plugin systems** before there's a second
  runner. Claude is the only runner until we add a real second one.
- **No DAG-only assumptions.** The graph is directed but cycles are
  first-class. Don't write code (or specs) that assume acyclicity.

## Architectural commitments (load-bearing — do not silently change)

These are the design decisions taken when starting the project. Changing them
should go through OpenSpec, not a casual refactor.

- **Language:** TypeScript. Node runtime, no Bun/Deno-isms in core.
- **Graph model:** directed, cycles allowed, bounded iteration budgets per
  cycle, optional human-in-the-loop gates engaged only on budget exhaustion
  or explicit escalation from a node.
- **Default executor:** `claude` CLI in streaming mode. Runner is pluggable
  via a typed interface so codex / opencode / others can slot in later.
- **Storage:** pluggable. Default impl = `bd` (beads) for work items + Dolt
  for run history. SQLite-only fallback for environments without either.
- **UI:** `minifac serve` daemon exposes a local web viewer. v0 = live run
  viewer only (stream output, show graph + node states, kick off runs).
  No in-browser YAML editing in v0.
- **Spec workflow:** OpenSpec. Two example factories ship with the repo:
  `hello.yaml` (trivial) and `sdd.yaml` (the propose/apply/verify/archive
  loop, which minifac uses on itself).

## Conventions

- File/dir names: kebab-case.
- TypeScript: strict mode on. No `any` without a comment explaining why.
- YAML: snake_case keys. The schema is the source of truth; document it in
  the spec, validate it at load time.
- Tests live next to the code (`foo.ts` + `foo.test.ts`) unless a directory
  earns its own `__tests__/`.

## Reference material (borrow, don't copy wholesale)

These projects on Jami's machine are fair game to mine for prompts, tool
shapes, and patterns. Borrow what helps; do not import structure or
nomenclature reflexively.

- `~/projects/scarif/` — prior art for the graph/workflow runner. Prompts and
  node-executor patterns are worth studying; the package layout, naming, and
  scope creep are explicitly **not** the model.
- `~/projects/twin-sun-claude-plugin/` — Twin Sun's AI rules and Claude Code
  conventions. Lift rules that translate; leave anything coupled to a
  specific Twin Sun workflow behind.

## When in doubt

Ask. The user prefers a clarifying question over a wrong-direction
implementation. The point of this repo is a small, clear core — err toward
**less** code, **less** abstraction, **less** indirection.
