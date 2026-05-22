## Why

`minifac autorun` is the long-running scheduler that babysits a queue
of briefs against the same primitive `minifac run` uses. Today its
only surface is line-prefixed text logs (or `--json` lines for
machines). When you're sitting at a terminal watching it, that's a
firehose: there's no compact view of which briefs are queued,
running, succeeded, or failed; no way to drill into a specific run
without firing up `minifac runs show <id> --follow` in another pane.

`minifac serve` covers the multi-run picture in a browser, but for
terminal-first sessions we don't have an equivalent. The archived
`run-tui` change already gave us a default-on TUI for the one-shot
`minifac run` case. Mirroring that affordance for `autorun` —
left pane of briefs with status circles, drill into a brief, drill
into a node, same `--raw` / `--tui` precedence — closes the gap
without forcing a browser.

## What Changes

- **NEW** `autorun-tui` capability — defines the brief-list reducer
  (pure event reducer that maps autorun scheduling events into a
  per-brief state list with status circles), the route/selection
  wiring (which brief is selected; selecting a brief drills into the
  existing `run-tui` surface for that brief's most recent run;
  selecting a node within that surface drills into its log stream),
  the layout (three vertically stacked bordered zones: header, body
  with the brief-list on the left and the existing run-mode view on
  the right, hotkey bar), and the hotkey contract (brief navigation
  + the existing run-mode hotkeys delegated to the embedded
  reducer).
- **MODIFIED** `auto-mode` — adds a TUI mode for the autorun
  process. The autorun event stream (`poll-start`, `started`,
  `skipped`, `completed`, `failed`, `dry-run-decision`) is the same
  input the brief-list reducer consumes; existing `--raw` and
  `--json` output paths are preserved verbatim so CI / pipelines
  stay stable.
- **MODIFIED** `run-cli` — the `autorun` subcommand grows `--raw`
  and `--tui` flags with the same precedence rules `minifac run`
  uses (`--raw` > `--tui` > `process.stdout.isTTY` > raw). `--raw`
  and `--tui` are mutually exclusive; `--tui` combined with `--json`
  is a usage error (the JSON output stream is a machine-readable
  contract and is not compatible with a mounted TUI). `--dry-run`
  and `--once` (when the operator wants pipeable output) implicitly
  prefer raw unless `--tui` is explicitly supplied.
- The TUI **does not change the autorun scheduler or the run
  primitive**. It is a new consumer of the same `AutorunEvent`
  callbacks the existing logger consumes, and a new consumer of the
  same `NodeEventEntry` stream the embedded run view consumes
  (via the existing `createInkRunRenderer` / `runReducer`
  surface). Persistence, signal handling, lockfile claims, and the
  poll loop are unchanged.

## Capabilities

### New Capabilities

- `autorun-tui`: the TUI rendering surface for `minifac autorun` —
  brief-list state shape and reducer, brief / node route wiring,
  layout (header, brief-list pane, embedded run-mode view, hotkey
  bar), and the brief-list hotkey contract. Lives independently
  from `auto-mode` and `run-cli` so the reducer can be unit-tested
  without the CLI argument-parsing surface and without spinning up
  a real scheduler.

### Modified Capabilities

- `auto-mode`: the autorun process grows a default-on TUI when
  stdout is a TTY. Existing `--raw` / `--json` output paths are
  preserved.
- `run-cli`: the `autorun` subcommand grows `--raw` and `--tui`
  flags, the precedence rule, and the `--tui` + `--json`
  incompatibility error.

## Impact

- `src/cli/autorun.ts` — accept `raw?: boolean` / `tui?: boolean`
  options on `AutorunOptions`; thread mode resolution through the
  existing `validateOptions` pass; in TUI mode, instead of
  attaching the human/JSON logger to stdout, attach an autorun-TUI
  renderer that consumes the same `AutorunEvent` stream.
- `src/cli.ts` — wire `--raw` / `--tui` flags on the `autorun`
  command using the same `pickOutputMode` function used by `run`,
  with the `--tui` + `--json` mutual-exclusion check added before
  the action runs.
- `src/tui/` (new files; do NOT touch the existing run-mode
  components):
  - `autorun-reducer.ts` — pure event reducer + brief-list state
    shape. Maps the `AutorunEvent` stream (plus UI events
    `select-brief-next`, `select-brief-prev`, `enter-brief`,
    `back-to-list`) to a `BriefListState`.
  - `autorun-app.tsx` — root `<AutorunApp>` component. Renders
    the brief-list pane and, when a brief is "entered", mounts
    the existing `<RunApp>` against that brief's per-run reducer
    state.
  - `brief-list-pane.tsx` — left pane: one row per brief with
    status glyph + change name + (when available) latest run
    status.
  - `autorun-renderer.ts` — `InkAutorunRenderer` adapter exposing
    `onEvent(AutorunEvent)`, `onRunEvent(change, NodeEventEntry)`,
    `waitForExit() → Promise<...>`. Owns the ink `render()`
    lifecycle.
- `src/cli/autorun.ts` — when TUI mode is active, the scheduler
  callbacks fan out to BOTH the per-run renderer (for the embedded
  run view) and the brief-list renderer (for status updates). The
  human/JSON logger is bypassed while the TUI is mounted; on TUI
  exit, the same final summary lines are emitted to stderr so
  scripts that grep them keep working.
- `*.test.ts(x)` alongside each new file. The autorun-reducer test
  mirrors `src/tui/reducer.test.ts` shape; the precedence test
  mirrors `src/cli.tui.test.ts`.
- `docs/concepts/Auto-Mode.md` — mention the TUI default and the
  `--raw` escape hatch for scripts and CI. (Light touch; the
  capability spec is the source of truth.)

### Out of scope

- **New autorun features.** Filters, controls, brief-level actions
  (cancel/retry from the TUI) — those are separate proposals.
- **Removing `minifac serve`.** Whether the TUI eventually
  obsoletes the daemon's web viewer is a future decision, not
  part of this change.
- **Mid-run intervention from the autorun TUI.** Pausing or
  messaging a node is the same gap as in the run-mode TUI; it
  depends on the same un-landed callback-status work.
- **Brief content panel.** The brief is on disk; the autorun TUI
  shows status, not content.
- **Sharing autorun TUI state with a remote viewer.** The daemon
  remains the path for shareable inspection.
- **Themes / customization** beyond the Unicode-vs-ASCII glyph
  fallback already specified for run-mode.
