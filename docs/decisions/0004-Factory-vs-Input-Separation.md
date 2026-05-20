---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0004: Factory and input are separate concepts

## Context

In the initial design, per-change YAML files were hand-edited copies of
the shipped `examples/sdd.yaml` — placeholder substitution for the
change name and `cwd`, plus an "intent" paragraph injected into the
propose node's prompt. Every per-change file was ~90% identical
factory boilerplate and ~10% change-specific data, glued together by
find-and-replace.

Worse, the glue was happening conversationally — a human (or Claude
Code) was authoring those YAML files by hand. That meant minifac
required Claude Code as the *integration point* between user intent
and the factory, which is not the role of a conversational tool.

## Decision

Split factories from inputs:

- **[[Factory]]** = workflow infrastructure. Lives with the minifac
  tool (canonical) or in `.minifac/factories/<name>.yaml` (per-repo).
  Versioned, shared, well-tested. Embeds topology, budgets, sentinel
  contract, prompt scaffolding.

- **[[Brief]]** = per-change data. Lives in the target repo under
  `inputs/<change>.md`. Small (`change`, `factory`, optional fields)
  + markdown body. Authored by humans (with or without AI help).
  Reviewable in PRs. Versioned with the code.

The factory's `propose` node consumes the brief body via runtime
templating; everything else is static factory infrastructure.

Brief authoring is *upstream* of the factory. Any tool — a Claude Code
skill, an editor, a CI bot, a copy-paste from a meeting — can produce
a conforming brief file. The factory runs from there.

## Consequences

- Per-change file shrinks from ~150 lines of YAML to ~30 lines of
  frontmatter + markdown body
- Multiple entry points become viable: CLI, web form, watched dir, CI
- Brief is reviewable on its own — the gate before spending API credits
- Factory updates broadcast across all consumers (new minifac → new
  factory version)
- Brief schema is small and stable; not coupled to OpenSpec's
  evolving artifact schema
- Re-runs become natural: edit the brief, run again, factory does its
  thing
- Claude Code is no longer the integration point between user and
  factory; it's just one of many possible brief-authoring tools

## Alternatives considered

- **Per-change YAML stays the unit.** (Status quo before this
  decision.) Rejected — high friction, conflates data with infra,
  forces a conversational tool into the loop.
- **Brief replaces the proposal entirely.** Have the brief-authoring
  conversation produce OpenSpec proposal files directly, skipping the
  factory's `propose` node. Rejected — they're at different
  abstraction levels (intent vs. formal OpenSpec artifacts), and the
  factory's `propose` does real mechanical work (validates against
  canonical specs, structures spec deltas) that a brief-authoring
  conversation shouldn't replicate.
- **Conversational AI as the integration substrate (Claude Code in
  the loop).** Rejected — couples minifac to a specific tool;
  conversational AI is best used for brief *authoring*, not for
  factory orchestration.

## Related

- [[Brief]]
- [[Factory]]
- [[Input]] (parent abstraction)
- [[0005-Brief-Schema]]
- [[0006-Verb-Shape]]
