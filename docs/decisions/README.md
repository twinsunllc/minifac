# Decisions

Append-only log of architectural decisions. Each note captures *why*
we chose something and *what we rejected*.

## Conventions

- **Immutable once accepted.** Don't edit accepted decision notes. If
  the decision changes, write a new note that supersedes the old, and
  update the old one's frontmatter (`superseded-by`).
- **One decision per note.** Atomic, linkable, citable.
- **Filename**: `NNNN-Kebab-Case.md`, four-digit zero-padded.
- **Wikilink liberally.** Decisions cite concepts (`[[Brief]]`,
  `[[Factory]]`) and other decisions.

## Template

```markdown
---
status: proposed | accepted | superseded
date: YYYY-MM-DD
supersedes: []          # list of decision ids this replaces
superseded-by: null     # set when a future decision replaces this one
tags: [decision]
---

# NNNN: Short title

## Context
What problem? What constraints? Links to relevant [[Concepts]].

## Decision
The choice we made. Be specific.

## Consequences
What follows from this decision — both the wins and the costs.

## Alternatives considered
Each alternative + why we didn't pick it. This is the section future
readers will thank you for.

## Related
- [[Concept-Notes-Affected]]
- [[Other-Decisions-That-Relate]]
```

## Status values

- **proposed** — written but not yet accepted (rare; we usually
  decide before writing)
- **accepted** — current, binding
- **superseded** — a later decision replaces this one; see `superseded-by`

## Reading order

Decisions are numbered chronologically but read by *concept*. Open
the concept note you care about (e.g. [[Brief]]) and follow the links
to the decisions that shaped it.
