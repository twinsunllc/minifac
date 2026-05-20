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
| `factory` | yes | Factory reference (`sdd`, `minifac:sdd`, etc.) |
| `base_branch` | no | Branch to base the [[Worktree]] on (default: caller's HEAD) |
| `model` | no | Per-brief Claude model override (default: factory config) |

Loader is **strict on required fields, permissive on unknown extras**.
Future fields (`depends_on`, `priority`, tags) slot in without schema
migration. See [[0005-Brief-Schema]].

Body is free-form markdown. The brief-authoring helper produces a
template with recommended sections (Background / What to do /
Out of scope / Acceptance criteria), but the loader does not enforce
them — a one-line body is still a valid brief.

## Where briefs live

`inputs/<change>.md` in the target repo by default. Discovered by
`minifac run` via the lookup precedence in [[0006-Verb-Shape]].

## Lifecycle

A brief is "ready" when its file exists. Runtime state (in-progress,
blocked, done) lives in the [[Runs-DB]], not in the brief file itself.
This separation is deliberate — see [[0012-Where-State-Lives]] — so
multiple workers can claim work without rewriting the brief.

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
