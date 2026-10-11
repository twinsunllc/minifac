---
status: accepted
date: 2026-10-11
supersedes: []
superseded-by: null
tags: [decision]
---

# 0049: Accept a workflow's `needs:` and ignore it

## Context

Scarif routes a factory job to a worker session by the job's capability
tokens (`needs`). An order that names none takes the factory repo's
`factory.yaml` `defaults.needs`. setandco's `android_build_check` workflow
said in a header comment to order it with `--needs linux --needs android`.
Two orders placed from Jira did not, took setandco's default
`[macos, xcode]`, and failed on Mac guests (SCARIFW-2229).

Scarif now reads a top-level `needs:` from the ordered workflow file and
merges it into the job's needs (scarif-spec
`openspec/changes/workflow-declared-needs`). The [[Factory]] schema is
strict at the top level, so a workflow carrying `needs:` would fail to load
with `Unrecognized key(s)`. The worker loads every workflow through
minifac, so minifac has to accept the key before a workflow can use it.

## Decision

- A workflow MAY declare `needs:`, a list of unique, non-empty strings. A
  scalar, a map, an empty, blank or non-string entry and a repeated entry
  are load errors that name the file and the `needs` key. scarif-web
  applies the same shape rules (`WorkItems::WorkflowNeedsSelection`).
- minifac carries the list on the resolved factory
  (`LoadedFactory.factory.needs`) and does nothing else with it. No runner,
  executor or storage code reads it.
- It is **not inherited through `extends:`**. Only the loaded file's own key
  counts, as for `uses_services:` ([[0045-Workflow-Uses-Services]]), and
  this matches how scarif-web reads it.
- minifac does not check the tokens against a vocabulary. The vocabulary
  belongs to Scarif, which refuses an unknown token when a job is ordered.
- The top level stays strict. Any other unknown key is still refused.

## Rejected alternatives

- **Inheriting through `extends:`.** A routing requirement that arrives
  silently from a library base is one the derived workflow's author never
  wrote, and scarif-web reads only the file's own key. Two readings that
  disagree would route a job on needs nobody validated.
- **Checking tokens against Scarif's vocabulary here.** A second copy of
  the vocabulary in minifac could drift from Scarif's, and a token Scarif
  adds would then fail to load on the droid.
