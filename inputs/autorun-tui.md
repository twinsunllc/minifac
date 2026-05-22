---
change: autorun-tui
factory: sdd
---

## Background

`minifac autorun` only emits plain text or `--json` log lines, so when
you're actively babysitting it locally there's no compact view of which
briefs are queued, running, succeeded, or failed. `minifac serve`
covers multi-run state in the browser, but for terminal-first sessions
there's no equivalent. A TUI that mirrors the `minifac run` renderer —
with a left pane for briefs — would close that gap without requiring a
browser.

## What to do

Add a TUI mode to `minifac autorun` that mirrors the `minifac run` TUI:

- Left pane lists briefs with status circles (queued, running,
  succeeded, failed, skipped).
- Selecting a brief shows that run's nodes/stages in the existing
  run-mode view.
- Selecting a node shows its log stream.
- Same `--raw` / `--tui` precedence as `run` (TTY → TUI, else raw;
  flags override).
- Reuse the existing Ink renderer where possible; new code limited
  to the brief-list pane and the route/selection wiring.

## Out of scope

Don't add new autorun features right now (e.g. filters, controls,
brief-level actions like cancel/retry from the TUI) — those would be
separate proposals. I do wonder if we want to eventually remove
`minifac serve`, but that's not in scope here.

## Acceptance criteria

- `minifac autorun` in a TTY defaults to TUI mode; `--raw` and `--tui`
  flags override per the same precedence as `run`.
- Left pane lists briefs with status circles; selecting one shows its
  run's nodes/stages.
- Selecting a node shows its log stream; interaction inside a selected
  brief matches the existing run TUI.
- Existing `--raw` and `--json` autorun output is unchanged (CI stays
  stable).
- Tests cover the brief-list reducer and the precedence resolver,
  mirroring `cli.tui.test.ts`.
