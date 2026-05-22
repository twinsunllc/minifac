---
status: accepted
date: 2026-05-18
supersedes: []
superseded-by: null
tags: [decision]
---

# 0013: Anti-goals — what minifac deliberately is not

## Context

minifac is a deliberate restart, designed to avoid the drift
patterns that grow on agent-workflow tools as they scale — the
metaphor creep, premature subsystem splits, and untyped plugin
registries that turn small clear cores into hard-to-reason-about
systems. We identified the specific patterns to *avoid* upfront,
so future contributors (human or AI) don't reintroduce them by
reflex.

These are codified in `CLAUDE.md` at the repo root, where they're
auto-injected into every Claude Code session. This decision note
records *why* each anti-goal exists, so a future contributor who's
tempted to violate one knows what they're trading off.

## Decision

The following are anti-goals — patterns to NOT reintroduce:

### 1. No anthropomorphic metaphors

A node is a node, not a "worker," "agent persona," "citizen," etc.
Things are named after what they do.

**Why:** Prior tools used metaphors that obscured what the system
actually does. "The citizen processes the work order" tells you less
than "the apply node runs the apply step." Metaphors also make code
harder to grep and reason about ("which file has the citizen logic?").

### 2. No premature subsystems

One TypeScript package until it has earned the right to split.

**Why:** Tools in this space have a recurring failure mode of
fragmenting into half a dozen packages before there are real
multi-package needs. Each split adds release coordination,
version management, and cross-package indirection. Defer until
the cost of not-splitting actually bites.

### 3. No untyped runner registries / plugin systems before a real
second consumer

Claude is the only [[Executor]] until we add a real second one. No
abstract plugin interface invented speculatively.

**Why:** Plugin systems designed before there's a second consumer
inevitably get the abstraction wrong — you guess at the variance
points and the actual second consumer wants different variance.
Build the abstraction *with* the second consumer.

### 4. No DAG-only assumptions

The graph is directed, but [[Cycle]]s are first-class. Code that
assumes acyclicity is a bug. See [[0002-Cycles-First-Class]].

**Why:** Realistic workflows (verify → apply, propose → apply →
verify → propose) loop. A DAG-only system would force users to express
iteration via copying, which doesn't scale and doesn't compose.

### 5. Strict TypeScript; no `any` without a comment

`strict: true`, `noUncheckedIndexedAccess: true`, no `any` unless an
inline comment explains why.

**Why:** Catches a class of bugs at compile time. Cheap on a fresh
codebase; expensive to retrofit on a mature one.

### 6. snake_case YAML keys

All YAML keys are snake_case, in factory definitions, briefs, and
config files.

**Why:** Consistency. The minifac CLI maps to camelCase internally
when it has to (e.g. `bypass_permissions` → `bypassPermissions` for
the claude CLI flag), but every YAML the user touches is snake_case.

## Consequences

- New contributors (human or AI) get this list at session start via
  `CLAUDE.md`
- Code review can cite specific anti-goals when pushing back on
  premature abstractions or metaphor-laden naming
- Future patterns can be added to this list (write a new decision
  note that supersedes this one if the framing materially changes)

## Alternatives considered

- **No codified anti-goals.** Rejected — relies on cultural transmission;
  doesn't survive contributor churn or AI-agent context resets.
- **Anti-goals only in `CLAUDE.md`, not in `docs/decisions/`.**
  Rejected — `CLAUDE.md` is for the agent's session-start context;
  decision-note rationale lives alongside other decisions for
  human-discoverable archaeology.

## Related

- `CLAUDE.md` — the operational list
- [[0001-Spec-Driven-Development]] — the process anti-goal pair
- [[0002-Cycles-First-Class]] — the DAG-only anti-goal
- [[0003-Claude-Streaming-Default]] — the "no plugin systems yet"
  anti-goal in action
