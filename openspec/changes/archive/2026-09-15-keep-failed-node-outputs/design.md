## Context

See proposal.md § Why. This document pins how the change lands in the
current runner and which shapes it deliberately leaves alone.

Current state, verified against `main` at proposal time:

- **One block decides.** `src/runner/run.ts`, post-execution outputs
  validation: `if (finalStatus === "succeeded" && node.outputs)` runs
  `validateDeclaredOutputs`; every other path leaves
  `outputsForResult = null`. On the missing-required-output override the
  partial index is persisted to `runs.db` (`recordNodeOutputs`) and
  carried on the failure event's `meta.partial_index`, but the
  `priorResults` entry is forced to `null`.
- **The validator is status-agnostic already.** `validateDeclaredOutputs`
  scans `<outputs_dir>` and returns `{ index, missing, detail }`; it has
  no notion of the node's status. `value` outputs are "present" when
  `<key>.json` exists and parses; `shape:` is reserved and only checked
  at the MCP tool boundary (`validateValuePayload`), so a file that
  parses is what "validation" means today.
- **The preamble mirrors `NodeResult` verbatim** (`node-executor`,
  "Prior-results JSON keys match the NodeResult shape"): `status` and
  `reason` already reach the model as JSON. What is missing is a
  template-side way to read them, and a non-null `outputs` to read from.
- **Template lookup is by latest iteration.** `substitutePriorResults`
  consults `Map<nodeId, NodeResult>` (latest wins) and returns `""` when
  `outputs` is `null` or the key is absent.

## Goals / Non-Goals

**Goals:**

- A node that fails with a parseable `<key>.json` beside it has that
  output addressable via `{{ priorResults.<id>.outputs.<key>[:read] }}`
  in every downstream node, exactly as if it had succeeded.
- A downstream prompt can read the source node's terminal status and
  reason without parsing the preamble.
- Succeeding nodes behave byte-for-byte as today.

**Non-Goals:**

- Edge payloads (`carries:`). Deferred; ADR 0041 records why.
- Per-iteration addressing (`priorResults.X:1.outputs.Y`) — still an
  open item in `docs/concepts/Outputs.md`.
- Distinguishing "node errored" from "node judged fail" (FINDINGS F10).
  Orthogonal; this change makes the payload available in both cases.
- Enforcing `shape:` on file-landed values. Unchanged.

## Decisions

### 1. Validation runs on every declared-outputs node; enforcement stays success-only

The block becomes two arms over `node.outputs`:

- `failed` → scan once (`lastValidation` is not reused: the nudge loop
  only runs on succeeded turn boundaries and a later turn may have
  failed after it). Index what is present-and-satisfied. Do not nudge,
  do not override, do not touch `reason`. If `missing` is non-empty,
  emit stderr lines
  `outputs_warning: node "<id>" failed and is missing required outputs: <keys> (dir: …); indexed: <keys|none>`
  plus the validator's per-key detail, and persist them as events.
- `succeeded` → as today, with one difference: `outputsForResult` is
  the index whether or not the override fires.

The uniform rule: `NodeResult.outputs` = the present-and-satisfied
index, or `null` when nothing was declared or nothing landed. Status
never zeroes it.

*Why a warning and not silence on a failed node's missing required
output:* the operator reading the run log should see that a routing
verdict lost its payload before the downstream node reads `""`. *Why
not a status change:* the node already failed for its own reason;
ADR 0027's "not additionally blamed" rule holds.

### 2. `NodeResult` shape is unchanged

No `outputs_warning` / `missing_outputs` field on the snapshot. The
warning is an event; the partial-ness is observable downstream as an
absent key (`""`), which is the existing convention for optional
outputs. Keeping the shape fixed means the executor preamble scenario
("exactly the keys … `outputs`, `nudges_used`, `session_id`"),
`runs.db`, `minifac runs --json` and the viewer are untouched.

### 3. Status and reason as template tokens, additive

`{{ priorResults.<id>.status }}` → `succeeded` | `failed`;
`{{ priorResults.<id>.reason }}` → the recorded reason (sentinel
REASON, `missing_required_output`, `resume_*`) or `""` when null. No
prior result → `""`. Implemented as a second regex pass beside the
outputs pass, so the 400-line "Brief token substitution" requirement is
not rewritten; the new requirement is ADDED and scoped to these two
forms. `substituteInputs` already leaves every `priorResults.*` token
verbatim at inlining time, so the #33 pass-through-inputs path works
for the new tokens without change.

### 4. Persistence follows the index

`recordNodeOutputs` was already called with the partial index on
override; it is now also called for a failed node's index. The
`node_outputs` table has no status column and needs none — the row's
`(node_id, iteration)` joins to `node_executions` for status.

## Risks / Trade-offs

- **A downstream node can now read a failed node's stale-looking
  output.** Mitigated: it could always read the preamble's `status`;
  now it can also branch on `{{ priorResults.<id>.status }}`. The
  Scarif evaluate/implement pair wants exactly this.
- **`:read` of a failed node's output that is large** throws the same
  64 KB template error as for a succeeded node. Unchanged contract.
- **Factories that relied on `""` for a failed source** (none shipped)
  see a path/contents instead.

## Migration Plan

None. No schema, storage or CLI surface changes.

## Open Questions

- Whether the `missing_required_output` override should be reconsidered
  once every workflow declares `outputs:` on failure-routing verdicts —
  out of scope; ADR 0027 stands.
