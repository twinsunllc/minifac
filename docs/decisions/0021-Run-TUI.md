---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0021: TUI as the default surface for `minifac run`

> Updated by [[0022-Run-TUI-Bounded-Borders]] — adds a bounded
> outer height and bordered + vertically-ruled zone shape.

## Context

`minifac run` today streams raw line-prefixed stream-json events
straight to stdout. Every event from every node — assistant
messages, tool calls, tool results, rate-limit events, system
init — arrives as a JSON line prefixed with `[node-id]`. The
result is technically lossless and pipe-friendly but
near-unreadable as an interactive experience. For a non-trivial
run (apply usually emits hundreds of events), the user can't tell
what node is doing what, where in the topology execution sits, or
whether progress is actually happening.

The daemon's web viewer (from `serve-and-viewer`) addresses the
same problem for daemon-mode runs, but `minifac run` is the
one-shot CLI path most users will hit first. It needs a
default-on TUI.

The output stream also has dual audiences:
- **Interactive users** need readable, structured presentation
- **Scripts, CI, and pipelines** need stable line-by-line text
  suitable for grep / awk / piping to a file

A single output mode can't serve both. Default behavior should
match the active audience.

## Decision

`minifac run` shows a TUI by default when stdout is a TTY,
streaming raw line-prefixed events otherwise. The choice is
overridable in both directions.

### Mode selection

- **TUI mode** (default when `process.stdout.isTTY`): renders the
  interactive layout described below
- **Raw mode** (default when stdout is not a TTY, or with
  `--raw`): emits the existing line-prefixed stream-json,
  unchanged from today
- **`--tui` flag**: forces TUI even into a non-TTY (rarely
  needed; useful for testing)
- **`--raw` flag**: forces raw output even into a TTY

The fallback ensures CI pipelines and `minifac run foo > log`
keep working without any changes.

### Layout

```
┌────────────────────────────────────────────────────────────────┐
│ minifac · brief: run-scoped-branches · factory: sdd · verify   │
├──────────────────────┬─────────────────────────────────────────┤
│ ● propose            │ [verify · iter 1 · running]             │
│ ● apply              │                                         │
│ ◔ verify       (1)   │  → running npm test                     │
│ ○ archive            │  ✓ 357 tests passed in 2.33s            │
│                      │  → running npm run build                │
│                      │  ⠋ ...                                  │
│                      │                                         │
│                      │                                         │
├──────────────────────┴─────────────────────────────────────────┤
│ ↑↓ select  enter follow  r raw  d details  q quit             │
└────────────────────────────────────────────────────────────────┘
```

- **Top bar**: project name (`minifac`), brief name (or
  `(brief-less)` for brief-less factory invocations), factory
  name, currently-active node name.
- **Left pane (status)**: one row per factory node, in
  topological-then-declaration order. Status glyph + node id +
  iteration count if > 1.
- **Right pane (logs)**: human-readable rendering of the
  selected node's stream of events.
- **Bottom bar**: minimal hotkey hints.

### Status glyphs

| Glyph | Meaning |
|-------|---------|
| `○` dim | Pending — not yet scheduled |
| `◔` animated | Running — current iteration in flight |
| `●` green | Most recent iteration succeeded |
| `●` red | Most recent iteration failed |
| `↻` yellow | Failed previously, retrying via on_failure |

Animated glyphs use Braille spinners (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) and degrade
to `*` on terminals without UTF-8.

### Iteration handling

The left pane shows **one row per node id**, not per (node,
iteration). Status reflects the most recent iteration's
outcome; the iteration count is a `(n)` suffix when > 1.

The logs pane defaults to the most recent iteration of the
selected node. A `<` / `>` key cycles through prior iterations
for cyclic runs (verify → apply recovery loops).

### Selection model

- **Default selection**: the currently-running node. Selection
  auto-advances to follow execution.
- **User selection takes over**: arrow keys / `j`/`k` move
  selection. Once the user has touched selection, auto-advance
  pauses (the user is driving). `Enter` resumes auto-advance
  ("follow mode").
- **Logs pane scrolls independently**: PgUp/PgDn for the right
  pane; selection in the left pane swaps which node's logs are
  shown.

### Log cleanup

Stream-json events are parsed and rendered with type-specific
summaries:

- `system / init` → suppressed (boilerplate)
- `rate_limit_event` → suppressed unless the status is
  `rejected` (real budget signal)
- `assistant / text` → rendered as prose, dim
- `assistant / tool_use` → one-line summary: `→ <ToolName>(<short args>)`
- `user / tool_result` → one-line summary indicating success
  or error; truncated content visible on hover/details
- `result` → the run's final terminal status, highlighted
- `status` (synthetic, from the runner) → highlighted line
  with a glyph

A `d` (details) toggle expands the selected log line to show
the full raw JSON for that event. Useful for debugging.

### Hotkeys

| Key | Action |
|-----|--------|
| `↑` `↓` / `j` `k` | Select node in left pane |
| `Enter` | Resume follow mode (auto-advance with run) |
| `PgUp` `PgDn` | Scroll logs pane |
| `<` `>` | Previous/next iteration for selected node |
| `d` | Toggle full-JSON details for highlighted log line |
| `r` | Toggle to raw mode for the rest of the run |
| `q` | Quit (run continues if not at terminal status; kills if mid-run with confirm) |
| `?` | Show help overlay |

### Run completion behavior

When the factory reaches a terminal node or terminates
abnormally:

- The status glyphs all settle to their final colors
- The top bar reflects final status ("succeeded" / "failed:
  <reason>")
- The TUI **stays open** with a footer prompt: `Run finished
  (succeeded). Press q to quit, m to merge.`
- The `m` hotkey, if the run is succeeded, invokes
  `minifac merge <change>` (or `minifac merge <run-id>` for
  brief-less) without leaving the TUI

### Library choice: `ink`

[ink](https://github.com/vadimdemedes/ink) — React for CLI.
Mature, actively maintained, TypeScript-native, used in
production by major CLIs (Gemini, Copilot CLI, others).
Component model fits the layout cleanly; testing helpers exist.
One runtime dependency added (`ink` + transitive React).

The cost-benefit calculus:

- Yes, this violates the "minimize new deps" instinct from
  CLAUDE.md
- But the TUI is a real new surface that hand-rolling would
  bury us — a maintained library is the right pragmatic call
- React-based component model also makes the future studio
  (if it leans React too) feel native to minifac contributors

### Streaming sink — composability

The TUI is wired in as a consumer of `runFactory()`'s existing
`onEvent` callback — no runner changes. The TUI's reducer
maps events into per-node state. The same callback continues
to feed runs.db persistence. Multiple consumers compose
naturally.

## Consequences

- `minifac run` becomes meaningfully more useful interactively.
  Watching a run is no longer "scroll through opaque JSON."
- Pipes / CI keep working transparently (auto-fallback to raw).
- New dependency: `ink`. Locked in `package.json`; the test
  surface gains TUI tests via ink's testing utilities.
- The TUI surfaces things the raw stream did not — like which
  iteration we're on for a cycling node — without changing
  runner semantics.
- A future studio surface can render the same shape over HTTP/SSE
  using the same event reducer logic. The TUI is a vertical slice
  of the same render pipeline.
- The `m` (merge) hotkey on completion ties the new
  [[0019-Run-Scoped-Branches]] merge verb directly into the
  one-shot run flow. Less context switching.

## Alternatives considered

- **No TUI; keep raw output.** Rejected — the raw output is
  the felt friction; this is why we're proposing.
- **`blessed`** (older Node TUI lib). Rejected — lower-level
  API, less momentum, harder to onboard contributors.
- **Hand-rolled ANSI** (no deps). Rejected — TUIs are tedious
  to write from scratch; the maintenance burden exceeds the
  dep tax.
- **TUI as opt-in (`--tui` flag, raw default).** Rejected —
  raw output is the worse default for interactive users; if
  TUI is good, it should be the default and raw the escape.
- **One row per (node, iteration) in the left pane.**
  Rejected — visually noisy for cyclic factories;
  `(n)` suffix + `<`/`>` iteration navigation is enough.
- **Always show all log events including system init and
  rate-limit chatter.** Rejected — readability is the point.
  Filtered presentation by default; full JSON via the `d` key
  for debugging.
- **Render TUI inside the daemon's web viewer instead.**
  Rejected — the daemon already has a richer surface; the
  TUI's job is the *one-shot CLI* case where there's no
  daemon. Both surfaces share the event-reducer logic.

## Open questions (in scope for the proposal phase)

- Exact color palette and Unicode fallbacks; depends on what
  ink + `chalk` make easy
- Whether the `m` (merge) hotkey opens a separate terminal
  prompt or merges inline with confirmation
- Whether the help overlay (`?`) is a separate "mode" or a
  popup
- Whether to show brief body content in a togglable panel
  (probably defer; brief is on disk anyway)

## Related

- [[Runner]] — `onEvent` callback consumed by the TUI; no runner
  changes
- [[Run]] — the unit the TUI displays
- [[Sentinel]] — terminal status drives the success/failure glyph
- [[0019-Run-Scoped-Branches]] — `m` (merge) hotkey ties into
  `minifac merge`
- [[Open-Questions]] — adds palette/fallbacks and merge UX
  questions; removes nothing
