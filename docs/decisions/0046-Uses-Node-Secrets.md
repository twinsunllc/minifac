---
status: accepted
date: 2026-10-03
supersedes: []
superseded-by: null
tags: [decision]
---

# 0046: A `uses:` node may carry `with: { secrets }`

## Context

Scarif vends secrets to a node that declares them in `with.secrets`. The
documented declaration, in scarif-factory's `declaring-a-secret` skill and
its secrets gate, is
`implement: { uses: implement, with: { secrets: [...] } }`. scarif-web reads
`with.secrets` from the nodes of the workflow file a job orders, and marks
the job as declaring secrets from that alone.

The [[Factory]] loader refused every `uses:` + `with:` pair as mutually
exclusive. So only a node written inline (`executor:` + `with:`) could
declare secrets, and a workflow built on library steps could not. The only
workaround was to put `with.secrets` inside a local step file, where
scarif-web does not look. A job declared that way would not be marked as
declaring secrets, so it would not be held to per-job hosts (SCARIFW-2072,
SCARIFW-2021).

## Decision

- Beside `uses:`, a node MAY declare a `with:` whose **only** key is
  `secrets`, and its value must be a list. Any other key, alone or beside
  `secrets`, is still refused with the old "mutually exclusive" wording. An
  empty `with: {}`, a non-mapping `with:` and a non-list `secrets` are
  refused too. Each refusal is one sentence naming the node.
- When the step is inlined, the node's list is copied unchanged and in order
  into the inlined `with` as `with.secrets`. It is not substituted, because
  it is not a string.
- **No override, no union.** If the step's own `with` already declares
  `secrets`, the node's `with.secrets` is refused, naming the node and the
  step, even when the two lists are equal. A reader of the workflow file
  should not have to open the step to learn which list wins.
- minifac does not check the entries. Their shape (a name, or
  `{ name, via }`) belongs to the consumer that reads `with.secrets`, as it
  already does for inline nodes.
- `uses:` + `executor:` is still refused, and so is `inputs:` without
  `uses:`.

## Rejected alternatives

- **Leave the loader alone and declare secrets in a local step file.** The
  file loads today, but scarif-web reads only the workflow file's nodes, so
  the declaration is invisible where it matters.
- **A general `with:` merge beside `uses:`.** Letting a node override any
  step key (`prompt`, `permission_mode`, `allowed_tools`) would make a
  pinned library step's behaviour depend on every workflow that uses it;
  `inputs:` is the declared way to vary a step. `secrets` is the one key that
  is about the job's environment rather than the step's behaviour.
- **Merge the node's list into the step's list, or let the node's win.**
  Either silently changes what a step file says. Refusing keeps one source
  for each node's list.
- **Validate entries in minifac.** That would put a second copy of the
  worker's declaration schema here, where it could drift.

## Related

- [[Factory]]
- [[0045-Workflow-Uses-Services]]
