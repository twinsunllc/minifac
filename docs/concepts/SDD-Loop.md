---
tags: [concept]
aliases: [sdd-factory, sdd, spec-driven-development, propose-apply-verify-archive]
---

# SDD Loop

The canonical [[Factory]] minifac ships: a propose → apply → verify →
archive cycle that drives spec-driven development against an
OpenSpec-equipped repo. It's both the example factory and the workflow
minifac uses on itself.

## Topology

```
propose ──▶ apply ──▶ verify ──▶ archive (terminal)
              ▲           │
              └── on_failure
                  (max_traversals: 3)
```

- **propose**: writes the OpenSpec change directory
  (`proposal.md`, `design.md`, spec deltas, `tasks.md`). Drives
  `openspec validate <change>` until clean.
- **apply**: works through `tasks.md`, marks checkboxes, commits.
- **verify**: runs the target repo's verify commands (typically
  `npm test`, `npm run build`, `npm run check`, `openspec validate`).
  Failure routes back to `apply` (bounded by `max_traversals: 3`).
- **archive** (terminal): runs `openspec archive <change>`, commits
  the move. Success ends the run.

## Per-node criteria

Each node's prompt declares what success and failure mean for that
phase. The [[Sentinel]] mechanics are injected by the [[Runner]] —
factory prompts don't carry the boilerplate. See
[[0007-Sentinel-Runner-Injects]].

## Permission posture

Every node opts into `permission_mode: "bypass_permissions"` so the
spawned [[Executor]] can actually do file work. The user is
responsible for `cwd` correctness; the prompts ship in this repo and
are readable before invocation; no remote injection vector. See
`openspec/specs/sdd-factory/spec.md` for the binding contract.

## Per-change customization

The SDD loop is brief-driven: each invocation reads a [[Brief]] from
`inputs/<change>.md` that supplies the change name and the intent.
The factory itself never changes per run.

## Dogfooding minifac on itself

Every change to minifac uses this loop. The dogfood happens on a
[[Worktree]] of minifac; the factory operates there; the result is a
branch the user reviews and merges.

## Related

- [[Factory]] — what an SDD loop is, as a category
- [[Brief]] — per-change input
- [[Cycle]] — the verify → apply recovery loop
- `openspec/specs/sdd-factory/spec.md` — canonical contract
- [[0007-Sentinel-Runner-Injects]]
