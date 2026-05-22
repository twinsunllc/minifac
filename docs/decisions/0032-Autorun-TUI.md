---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0032: Autorun TUI — terminal viewer parallel to run

## Context

`minifac autorun` only emits plain text or `--json` log lines (see
`src/cli/autorun.ts`). When you're actively babysitting an autorun
session locally, there's no compact view of which briefs are queued,
running, succeeded, or failed — you scroll log lines and grep.

[[0016-Auto-Mode]] left the viewer story to `minifac serve`, which
covers multi-run state in the browser. That works when you're
browser-first, but for terminal-first sessions (the dominant mode in
practice) it's a context switch every time you want to check the
backlog. Meanwhile `minifac run` already grew a TUI per its own
proposal — the Ink renderer in `src/tui/` is well-factored and used
by tests via the renderer-factory seam in `src/cli.ts`.

## Decision

**Ship a TUI mode for `minifac autorun` that parallels `minifac
run`'s TUI**, reusing the existing Ink renderer for the run-detail
view and adding a left pane that lists briefs.

- **Output precedence** matches `run`: TTY → TUI, else raw; `--raw`
  and `--tui` flags override per the same resolver
  (`pickOutputMode` in `src/cli.ts:75`).
- **Left pane** lists briefs known to the current autorun session
  with status circles (queued, running, succeeded, failed, skipped).
- **Selecting a brief** swaps the right pane to the existing
  run-mode renderer for that brief's run.
- **Selecting a node** inside the right pane shows its log stream —
  same interaction as today's run TUI.
- **`--raw` and `--json` output unchanged.** CI consumers stay
  stable.

The TUI is **additive** to `minifac serve`. Serve remains the
canonical browser dashboard; this is the terminal-first parallel,
not a replacement.

## Consequences

- A second presentation surface for autorun. Same data, two
  renderers (terminal + browser). Worth it for terminal-first
  workflows; the cost is real but bounded because the run-detail
  half of the TUI is the existing component.
- The brief-list pane is new code (reducer + Ink view). Mirrors the
  shape of `src/tui/reducer.ts` so reviewers have a precedent.
- Test coverage parallels `src/cli.tui.test.ts`: precedence
  resolver and brief-list reducer get their own suites.
- Does not change autorun's scheduling, dependency, or failure
  semantics. Pure presentation.
- Whether `minifac serve` is still worth maintaining once the TUI
  ships is an open question — flagged in the brief, not decided
  here.

## Alternatives considered

- **Compact status line only** (queue depth / in-flight / last
  poll, appended to the existing text output). Cheap, but doesn't
  solve the "I want to see what node is currently running on brief
  X" case that the serve viewer answers today. Rejected as
  insufficient on its own; could still ship inside `--raw` mode if
  cheap.
- **TUI without the brief-list pane** (just render the
  currently-active run). Doesn't match the multi-run-at-once shape
  that `--max-concurrent > 1` enables, and loses the queued/done
  visibility that's the main reason to want this. Rejected.
- **Rely on `minifac serve`; don't add a TUI.** The status quo.
  Rejected on ergonomic grounds — terminal-first usage is dominant
  enough that the browser hop is felt.
- **Add brief-level actions to the TUI** (cancel, retry, skip).
  Out of scope for this ADR; would be a separate proposal. Keeping
  v0 read-only matches the read-only posture of the run TUI.

## Related

- [[0016-Auto-Mode]] — defines `minifac autorun`, deferred the
  viewer to serve
- [[Runs-DB]] — shared state source for both renderers
- [[Open-Questions]] — adds "Does serve survive once the TUI
  ships?" as a follow-up trigger
