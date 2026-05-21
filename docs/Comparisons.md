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

## vs. gas-city / gastown (tmux + Claude Code orchestration)

Gas-city orchestrates multiple Claude Code sessions in tmux panes
— each pane is a conversation; the human switches between them.

**Where minifac is different:**

- Gas-city: conversational. Minifac: structured. Each minifac node
  is a one-shot invocation with structured input ([[Brief]] +
  prior results) and structured output ([[Sentinel]] / callback).
- Gas-city: human-in-the-loop by default. Minifac:
  unattended-by-default (auto-mode is the build farm; mid-run
  human-in-the-loop is an opt-in capability).
- Gas-city: per-session state in tmux. Minifac: per-run state in
  [[Runs-DB]] — reproducible, queryable, surviving across
  daemon restarts.
- Gas-city: TMUX-as-substrate (leaky abstraction). Minifac: HTTP
  daemon + viewer or one-shot CLI; no terminal multiplexing in the
  contract.
- Gas-city: metaphor-heavy naming (the thing minifac's anti-goals
  explicitly reject).

Rough analogy: gas-city is "team chat of AI contractors"; minifac
is "CI/CD with AI participants." Different shapes of problem.

## vs. Scarif (the prior internal tool this is replacing)

Scarif paired Jira tickets with workers that pull from a queue.
Tickets carry intent + state; workers run factories against them;
human interaction is via Jira comments.

**Where minifac is different:**

- Tickets-in-Jira vs. briefs-in-git. Same shape (markdown
  description, optional metadata), but minifac's briefs are
  reviewable in PRs and travel with the code.
- Scarif's factory definitions accumulated in Scarif; per-repo
  customization required Scarif knowledge. Minifac factories live
  in `.minifac/factories/` per repo (composable via `extends:`,
  per [[0008-File-Per-Factory-Composition]]).
- Scarif grew bloated (multiple packages, metaphor-heavy naming,
  Jira coupling). Minifac's anti-goals
  ([[0013-Anti-Goals]]) explicitly resist that drift.

The intent is to keep Scarif's good parts (factory-as-unit-of-work,
queueable backlog, gated interaction) and drop the costs (vendor
coupling, premature subsystems, metaphor noise).

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
