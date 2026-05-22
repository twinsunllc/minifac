---
tags: [living-doc]
---

# Comparisons — what minifac is and isn't

A living doc that captures honest comparisons with adjacent tools.
Useful for self-reference (what did we decide differentiates us),
for the eventual open-source pitch, and for resisting reflexive
"let's add that feature" temptations when an existing tool already
does it well.

## vs. n8n / Zapier / Make.com (general workflow automation)

These are mature visual workflow tools with 600+ integrations,
strong service-connector libraries, and SaaS or self-hosted
runtimes. They're great for "automate this business process" use
cases.

**Where minifac is different:**

- They are *integration-shaped* — nodes connect services. Minifac
  is *agent-shaped* — nodes are LLM invocations operating on code.
- They run-to-completion; conversation is not a paradigm. Minifac
  supports mid-run intervention (via the future callback transport)
  and post-run conversation with frozen runs.
- They centralize workflows in their own state stores. Minifac is
  git-native — briefs in `inputs/`, factories in `.minifac/`,
  outputs as commits.
- They lean visual-first. Minifac is YAML-first with optional UI;
  the artifacts are reviewable in plain git diff.

**Where we should not try to compete:** a visual workflow builder
alone, with no other differentiation, would be reinventing n8n with
fewer integrations. The visual layer in any future [[Studio]]
should serve inspection and chat — not authoring as a primary
mode.

## vs. LangGraph / LangChain Studio

LangGraph is closer to minifac in spirit — graph-shaped workflows
of LLM nodes. LangGraph Studio is its visual debugger.

**Where minifac is different:**

- LangGraph is library-shaped — workflows live as Python (or TS)
  code in your application. Minifac is tool-shaped — factories are
  YAML data, runnable from any repo.
- LangGraph is general — primitives for any LLM workflow. Minifac
  is opinionated — propose/apply/verify/archive is the canonical
  shape, with cycles and budgets as load-bearing structural features.
- LangGraph workflows are authored in code; minifac briefs are
  authored as markdown. Different mental models for "what's the
  unit of work."

## vs. Gas City

[Gas City](https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607)
is an MIT-licensed SDK for multi-agent autonomous orchestration —
Steve Yegge's vision, built by Julian Knutsen and Chris Sells. It
ships declarative "packs" of agent teams that run on the MEOW
stack: [Beads](https://github.com/steveyegge/beads) for work
items, [Dolt](https://github.com/dolthub/dolt) for git-versioned
state. v1.0.0 released recently with an active community.

Both projects converge on a surprising amount: declarative
configuration of agent work, repo-rooted versioned state, audit
trails, and treating individual agent invocations as composable
building blocks rather than long-running sessions. Gas City uses
Dolt; `dolt-adapter` is on minifac's deferred list. The shared
intuitions are real.

**Where the projects diverge:**

- **Scope.** Gas City targets agent automation across *any*
  business process — replacing low-end SaaS, running ops, light
  and dark factories that span domains. minifac is narrower:
  repo-rooted, code-focused, developer-tool work driven by SDD
  loops on a single codebase. Gas City's broader scope is the
  ambitious move; minifac's narrower scope is the focused move.
- **Concurrency model.** Gas City "packs" have multiple
  identity-bearing agents that can message each other and reach
  consensus. minifac nodes run sequentially or via explicit
  cycles, but they don't have inter-node identity or messaging
  — each invocation is one-shot, structured input in /
  structured output out.
- **Naming style.** Gas City uses rich metaphor (packs,
  formulas, shepherds, polecats, dark / light factories) —
  ecosystem personality at the cost of newcomer ramp.
  minifac names things after what they do (factory, node,
  brief, run, executor) — flatter, more greppable, less
  colorful. Different audiences will prefer different
  defaults; we've picked ours.
- **Substrate.** Gas City: MEOW + Beads + Dolt. minifac:
  one TypeScript package + SQLite + HTTP daemon. Gas City gives
  you more out of the box; minifac gives you fewer moving
  parts.

If you're building multi-agent autonomous operations across
multiple business domains, Gas City is the more developed
platform and the bigger community. If you're orchestrating a
spec-driven development loop on a single repo with explicit
human gate points, minifac fits closer to that grain. The two
tools are more adjacent than competitive.

## vs. ticket-queue agent runners (Jira-coupled or similar)

Some agent workflow tools pair an external ticket system (Jira,
Linear, GitHub Issues) with worker processes that pull from a
queue. Tickets carry intent + state; workers run a factory
against each one; humans interact via ticket comments.

**Where minifac is different:**

- Tickets-in-Jira vs. **briefs-in-git**. Same shape (markdown
  description, optional metadata), but minifac's briefs are
  reviewable in PRs and travel with the code that depends on
  them.
- External factory definitions vs. **`.minifac/factories/` per
  repo** (composable via `extends:`, per
  [[0008-File-Per-Factory-Composition]]). No central catalog
  to keep in sync; per-repo customization needs no knowledge of
  a remote system.
- Vendor coupling vs. **no required vendor**. minifac talks
  HTTP to the executor and writes runs to local SQLite. No
  Jira account, no central queue service. Ticket-queue tools
  can be very good — they're just a different shape of
  trade-off (centralization for visibility) than minifac picks
  (locality for portability).

minifac's anti-goals ([[0013-Anti-Goals]]) explicitly resist the
drift toward central-catalog + metaphor-heavy naming + multiple
packages that tends to grow on tools in this space.

## vs. Claude Code itself

Claude Code is the conversational tool minifac dispatches to. Asked
differently: when does it make sense to invoke minifac vs. just
use Claude Code directly?

- Use Claude Code directly for *exploration* — fuzzy intent,
  one-off work, anything where the dialogue is the work.
- Use minifac when the work has a *repeatable structure* —
  propose/apply/verify/archive, recurring drift checks, nightly
  security triage. Structure is the value.
- Use minifac when you want the work to be *unattended* — author a
  brief, walk away, come back to a PR.

A future [[Studio]] might collapse some of the distinction by
adding conversational affordances on top of structured runs. That's
a deliberate move, not a default — see "Studio direction" below.

## Studio direction — what we're leaning toward

If [[Studio]] gets built, the strategic guidance is:

**Lean into the chat-with-a-run paradigm. Skip the visual workflow
builder.**

The visual builder alone is "n8n with React Flow" — a crowded space
where minifac would be the new entrant with the fewest integrations.
The interesting paradigm is *chat anchored to a structured run* —
postmortem ("why did this fail"), mid-run steering ("hey, also do
X"), inspection ("walk me through what happened on the verify
retry"). That surface is under-served by existing tools — most
tools sit on one side or the other (run inspection without chat,
or chat without a durable structured run model to anchor to).

Studio's likely v1 surface:
- Run inspector (replay [[Runs-DB]] runs visually)
- Chat with a finished run (LLM with access to that run's `priorResults`,
  events, factory definition, brief)
- Chat with a *running* node (depends on
  [[0017-Callback-Status-Signaling]])
- Brief authoring as a guided conversation (already exists as a
  CLI / skill; UI surface optional)

Notably absent from v1: a visual factory designer. YAML stays the
source of truth for authoring; visual surfaces are for inspection
and conversation. If a visual designer earns its way in later,
fine — but it's not the differentiator.

## Studio packaging — separate project

Decision (not formally an ADR yet, but the leaning): [[Studio]] is
a separate project (`minifac-studio/`), not a package inside
minifac. The boundary is the daemon's HTTP API. The case for
monorepo (shared TS types) is real but not load-bearing — a
published types package handles type sync without a workspace
tooling tax.

This stance gets revisited if cross-cutting changes between engine
and studio become frequent enough to feel painful.
