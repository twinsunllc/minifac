---
status: accepted
date: 2026-05-18
supersedes: []
superseded-by: null
tags: [decision]
---

# 0001: Spec-driven development with OpenSpec

## Context

minifac is a tool for running structured workflows against repos. The
team has prior experience with bloated tools that grew without a
disciplined change process. We wanted to dogfood the way we build
minifac — every behavior change goes through a deliberate spec phase,
not a "just commit and hope" pattern.

## Decision

Adopt OpenSpec for the project's change workflow. Every non-trivial
change to minifac goes through:

1. **propose** — write `proposal.md`, `design.md`, spec deltas, `tasks.md`
2. **apply** — implement the tasks; verify gate must pass
3. **archive** — fold the spec deltas into canonical `openspec/specs/`

This is the [[SDD-Loop]]. The factory minifac itself ships as
`examples/sdd.yaml` embodies the same loop.

## Consequences

- Architectural changes leave a written record (proposal + design)
- The canonical spec under `openspec/specs/` is the binding contract;
  the implementation conforms to it
- Cycle time on small changes is higher than "just commit"; intentional
- Future contributors can follow the same loop without re-discovering it

## Alternatives considered

- **Bespoke spec system.** Reinventing OpenSpec's structure with our
  own conventions. Rejected — OpenSpec is mature, has tooling
  (`openspec validate`, `openspec archive`), and integrates with
  Claude Code via skills.
- **Markdown docs in `docs/`.** Just write design notes without the
  propose/apply/verify/archive structure. Rejected — no enforcement,
  no cycle, drifts from code quickly.
- **No process; trust contributors.** Rejected as a starting point —
  the discipline is itself the value, especially when the
  contributor pool includes unattended AI agents.

## Related

- [[SDD-Loop]] — the workflow embodied as a factory
- `openspec/specs/sdd-factory/spec.md` — canonical contract
- [[0013-Anti-Goals]] — process-related anti-goals
