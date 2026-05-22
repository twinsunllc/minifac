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

## vs. gas-city / Gas Town (tmux + Claude Code orchestration)

[Gas Town / gas-city](https://sourcegraph.com/blog/revenge-of-the-junior-developer)
(Steve Yegge's work) orchestrates multiple Claude Code sessions
in tmux panes — each pane is a conversation; the human switches
between them. It's an elegant and influential design for
human-in-the-loop multi-agent work, and minifac borrows the
intuition that the human's eye is the load-bearing piece in
non-trivial agent orchestration.

**Where minifac picks differently:**

- Gas-city is **conversational**; minifac is **structured**.
  Each minifac node is a one-shot invocation with typed input
  ([[Brief]] + prior results) and typed output ([[Sentinel]] /
  callback). Better for replay / audit; gives up the
  steer-mid-stream affordance unless you opt into callbacks.
- Gas-city is **human-attended by default**; minifac is
  **unattended by default**. Auto-mode is the build farm;
  mid-run human-in-the-loop is an explicit opt-in via the
  callback transport. Different default makes sense for
  different tasks.
- Gas-city: **per-session state in tmux**. Minifac: per-run
  state in [[Runs-DB]] (SQLite), surviving daemon restarts and
  queryable across runs.
- Gas-city: **tmux** as the orchestration substrate — leans on
  it for visual layout and process supervision. Minifac:
  HTTP daemon + web viewer (or one-shot CLI), no terminal
  multiplexer in the contract. Trade-off, not a critique:
  tmux gives you instant local visual orchestration without a
  daemon; minifac's daemon model gets you the web viewer and
  remote inspection.

Rough analogy: gas-city is "team chat with AI collaborators";
minifac is "CI/CD with AI participants." Different shapes of
problem; honest about which is which.

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
retry"). That surface is genuinely under-served by existing tools
(LangSmith has run inspection but no chat; Cursor has chat but no
structured run model; gas-city has chat but no structure to anchor
to).

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
