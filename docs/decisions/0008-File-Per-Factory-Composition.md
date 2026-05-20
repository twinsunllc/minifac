---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0008: File-per-factory composition with `extends:` for per-repo customization

## Context

Different repos using minifac need to customize the [[SDD-Loop]] (or
other shipped factories) — most commonly the verify commands
(`bun test` vs `npm test` vs `pytest`). At the same time, the team
ships canonical factories that should be **broadcastable** — when
minifac releases a new factory version, every repo can opt into it
without copying.

This is the classic "shared infrastructure vs per-project config"
problem, solved cleanly by GitHub Actions, npm, direnv, etc.: the
*tool* + *building blocks* are shared and versioned; the *composition*
and *data* live in the repo.

## Decision

- Built-in factories ship with the minifac tool and are referenced as
  `minifac:<name>` (e.g. `minifac:sdd`).
- Per-repo customizations live as **one file per factory** at
  `.minifac/factories/<name>.yaml`. Each file may declare
  `extends: "minifac:<name>"` at the top and override per node.
- Override semantics: **replace-at-node-level**. If you override
  `verify`, the entire `verify` node from the base is replaced by the
  override. No deep-merge in v0.
- Brief's `factory: <name>` resolves against
  `.minifac/factories/<name>.yaml` first; falls back to
  `minifac:<name>` built-in if no local file exists.
- Brief authors can also reference `factory: minifac:<name>` directly
  for no-customization passthrough.

Optional `.minifac/config.yaml` for non-default `inputs_dir`,
`worktrees_dir`, etc. — not required if conventions suffice.

`minifac init` bootstraps `.minifac/` in a new repo.

For v0, factory versioning is **tool-version-locked** — `minifac:sdd`
means "the SDD factory that ships with this version of minifac."
Independent factory SemVer is deferred to [[Open-Questions]].

## Consequences

- Each factory is a coherent file, easy to share across repos by
  copying
- Per-repo customization is per-node, not per-field — predictable, no
  ambiguous merge semantics
- A repo with multiple custom factories has multiple files, not one
  monolithic config
- The `extends:` field at the top of a YAML is a familiar shape
  (Docker Compose, GitHub Actions composite actions)
- Broadcasting: new minifac version → new factory templates →
  every repo's `extends: "minifac:sdd"` gets the update on
  upgrade. Per-repo overrides remain intact (the override targets the
  same node ids, regardless of base changes — unless the base renames
  a node, in which case the override targets a missing node and
  errors at load time, which is the right failure mode)
- Custom-from-scratch factories work too (no `extends:`) — the escape
  hatch for repos that want fully bespoke workflows

## Alternatives considered

- **Single config file** `.minifac/config.yaml` with all factories
  inline. Rejected — gets long once you have ≥3 factories; doesn't
  match the file-per-thing pattern most tools use.
- **Deep-merge override semantics.** Rejected for v0 — ambiguous
  rules (arrays: concat or replace?), and the cost of copying a whole
  node when you only want to change one field is small. Can earn its
  way in later if friction is real.
- **Factory registries from day one** (multi-repo sharing of custom
  factories). Rejected — premature; defer until a second repo
  actually wants the same custom factory.
- **Independent factory versioning from day one.** Rejected — adds
  release-management surface area; tool-version-lock is enough until
  proven otherwise.

## Related

- [[Factory]]
- [[Brief]]
- [[0004-Factory-vs-Input-Separation]]
- [[Open-Questions]] — independent factory versioning, factory registries
