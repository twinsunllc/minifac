---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0005: Brief schema — required + optional fields, permissive on extras

## Context

The [[Brief]] needs a schema for the [[Runner]] to consume it
reliably. Too tight and authors fight the schema; too loose and the
factory can't trust what it gets. The schema also needs to leave
room for future fields (`depends_on`, `priority`, etc.) without
forcing migrations.

## Decision

YAML frontmatter:

| Field | Required | Purpose |
|---|---|---|
| `change` | yes | Change name (kebab-case) |
| `factory` | yes | Factory reference (`sdd`, `minifac:sdd`, etc.) |
| `base_branch` | no | Branch to base the worktree on (default: caller's HEAD) |
| `model` | no | Per-brief Claude model override (default: factory config) |

Plus markdown body, free-form, with **recommended sections via the
brief-authoring template** but **no loader enforcement**. A one-line
brief is valid.

Loader behavior:

- **Strict on required fields** — missing `change` or `factory` is an
  error
- **Strict on known field types** — `base_branch: 42` is an error
- **Permissive on unknown extras** — `depends_on: [other]` parses
  through without error even though v0 doesn't use it

`factory:` reference syntax supports pinning when versioning ships
(e.g. `factory: sdd@1.2`). v0 is just a name lookup.

## Consequences

- New optional fields can be added (`depends_on`, `priority`, `tags`)
  without a schema migration — they're already valid extras
- Briefs are minimal in the common case (two required fields + body)
- The recommended-section template gives authors structure when they
  want it, without taxing one-line briefs
- The factory's `propose` node has to be tolerant of variable body
  shapes — already true since briefs are free-form by design
- `factory:` field forces every brief to be self-describing — you can
  read a brief and know which factory it targets, no `.minifac/config.yaml`
  required to interpret it

## Alternatives considered

- **`change` only required; everything else optional including
  factory.** Rejected — without `factory`, the brief isn't
  self-describing; you'd need repo context to interpret it. Worth the
  one extra required field for portability.
- **Required sections in the body** (Background / What / Out of scope
  / Acceptance criteria). Rejected — too rigid; small changes get
  bloated with empty sections. Template via the authoring helper hits
  the same ergonomic point without the loader tax.
- **Strict-everywhere schema** (reject unknown extras). Rejected —
  forces a migration ceremony every time we want to add a field;
  permissive-on-extras lets us evolve without that.
- **TOML/JSON5/HCL frontmatter.** Rejected — YAML matches the rest
  of the system (factory definitions, OpenSpec) and Obsidian /
  general markdown tooling expects it.

## Related

- [[Brief]]
- [[0004-Factory-vs-Input-Separation]]
- [[0006-Verb-Shape]] — how the brief is invoked
- [[Open-Questions]] — `brief-deps-and-state` builds on permissive-extras
