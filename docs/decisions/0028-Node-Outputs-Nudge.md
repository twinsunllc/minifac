---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0028: Output-missing nudge — single-turn recovery

## Context

[[0027-Node-Outputs]] introduces declared required outputs and
the `missing_required_output` failure mode: when the model
emits `MINIFAC_STATUS: succeeded` but doesn't produce a
declared required output, the runner overrides to failed.

A bare "fail and let the graph retry" semantics is *correct* but
wasteful in the common case. A missing tool call or a forgotten
JSON write is almost always a *protocol* failure — the model
did the substantive work, just forgot the reporting step. Sending
the whole node back through a graph-level retry burns the entire
prior run.

The Claude CLI in stream-json mode accepts new user messages
over stdin **after** a `result` event — that event signals
end-of-turn, not end-of-session. The runner can hand the model
another turn with a synthetic user message describing what's
missing, and the model has a chance to call the right tool /
write the right file before the runner gives up.

This is the same principle as the existing graph-level
recovery edge (`verify → apply when: on_failure`), applied one
abstraction level down: graph-level cycles handle substantive
failures; the nudge handles protocol failures.

## Decision

After the runner detects missing required outputs but before
recording the terminal status, it sends a single nudge turn
back to the model. If the model still hasn't produced the
outputs after the nudge turn completes, the node fails as
described in [[0027-Node-Outputs]].

### Mechanics

1. Executor emits its terminal `result` event.
2. Runner runs the outputs-validation pass from
   [[0027-Node-Outputs]].
3. If outputs valid → record `NodeResult` with `succeeded`
   (existing flow).
4. If outputs missing AND `output_nudge_budget > 0`:
   - Decrement the budget (in-runner state, not in factory)
   - Write a synthetic user message to the still-open stdin
     of the Claude CLI:
     ```
     The following declared required outputs were not produced:

       - findings (type: value): expected at <outputs_dir>/findings.json
       - report (type: file): expected at <outputs_dir>/report.md

     Please produce these outputs now. After they're written,
     emit MINIFAC_STATUS: succeeded (or MINIFAC_STATUS: failed
     with a REASON if you cannot produce them).
     ```
   - Wait for the next `result` event
   - Re-run outputs validation
5. If outputs valid after the nudge turn → record `succeeded`.
6. If outputs still missing → record `failed` with
   `missing_required_output` as in [[0027-Node-Outputs]].

### Schema — per-node budget

```yaml
nodes:
  security-review:
    outputs:
      findings: { type: value, required: true }
    output_nudge_budget: 1   # default 1; set to 0 to disable
```

Default budget of `1` is intentionally conservative. Empirically
a single nudge catches the "model forgot one tool call"
failure mode, which is the dominant case. Higher budgets risk
the model confabulating outputs to satisfy the contract; lower
budgets (zero) lose the cheap-recovery affordance.

Factories that want strict no-nudge semantics opt out with
`output_nudge_budget: 0`.

### Event tagging

Runner-emitted events during the nudge are tagged distinctly
from model events so the TUI / web viewer / runs.db replay
can render them differently:

```
[security-review] system / runner-action — "Required outputs missing, nudging..."
[security-review] user / runner-nudge   — "<the nudge message>"
[security-review] assistant / text      — "Sorry, calling the tool now."
[security-review] tool_use              — Write(...)
[security-review] result                — turn N+1 ends
```

These events persist to `runs.db` like any other event,
ensuring the audit trail captures runner interventions.

### Sentinel-failed nodes are NOT nudged

If the executor terminated with `MINIFAC_STATUS: failed`, the
output check is skipped entirely (per [[0027-Node-Outputs]])
and no nudge is sent. The model honestly reported failure;
there's no protocol mistake to recover from.

## Consequences

- **Cheap recovery for the common case.** One forgotten tool
  call no longer burns the entire prior run. The model gets a
  short turn to fix it.
- **Bounded blast radius.** Budget of 1 by default; max 1
  extra turn per node. Predictable cost ceiling.
- **Auditable.** Distinct event tags + persistence in
  `runs.db` mean nudges are visible in the run log forever.
  No "the runner secretly fixed something."
- **Opt-out for strict semantics.** Factories that prefer
  no-second-chances semantics set `output_nudge_budget: 0`.

## Alternatives considered

- **No nudge — first attempt or fail.** Rejected — wastes the
  full prior work on a recoverable protocol mistake. Wastes
  apply cycles in particular, which are the expensive ones.
- **Unlimited nudges.** Rejected — risks infinite loops when
  the model is in a confused state. Bounded budget gives one
  cheap shot then defers to graph-level retry.
- **Default budget 2.** Considered. Rejected — empirically one
  shot covers the "model forgot" case; a second shot mostly
  represents "model is confused and confabulating to satisfy
  the contract," which is worse than just failing the node.
- **Out-of-band notification (email, log, etc.) rather than
  in-context nudge.** Rejected — the model needs the missing-
  outputs info *in its working context* to act on it. An
  email doesn't help.
- **Always nudge regardless of sentinel state (succeeded *or*
  failed).** Rejected — would force the model to "redo work
  it already knew it couldn't complete." Sentinel-failed
  nodes get to fail in peace.

## Open questions

- Should the nudge message be customizable per factory (so a
  factory author can write their own retry copy)? Leaning
  *no* for v1 — the canonical message is fine; revisit if
  someone asks.
- Should we surface a `nudges_used` field in `NodeResult` for
  observability? Likely yes, small addition; fold into the
  brief rather than ADR scope.

## Related

- [[0027-Node-Outputs]] — establishes the
  `missing_required_output` failure mode this ADR softens
- [[0007-Sentinel-Runner-Injects]] — analogous pattern (runner
  shapes model behavior via the conversation channel)
