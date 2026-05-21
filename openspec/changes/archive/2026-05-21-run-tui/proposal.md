## Why

`minifac run` today prints line-prefixed stream-json events straight to
stdout. Lossless and pipe-friendly, but unreadable as an interactive
experience — a non-trivial run is hundreds of opaque JSON lines with no
sense of where execution sits in the topology. Decision
[`0021-Run-TUI`](../../../docs/decisions/0021-Run-TUI.md) binds the
answer: `minifac run` SHALL show a default-on TUI when stdout is a
TTY, falling back to today's raw output otherwise. This change builds
that surface and wires it into the existing `runFactory()` event
stream without changing the runner.

## What Changes

- **MODIFIED** `run-cli` — the `run` subcommand SHALL default to TUI
  output when `process.stdout.isTTY` is true and SHALL fall back to
  the existing line-prefixed raw output otherwise. Two new flags,
  `--raw` and `--tui`, override the default in each direction. The
  existing raw output format is preserved verbatim for raw mode (and
  the final `[run]` stderr summary line is unchanged in both modes).
  The subcommand's hotkey contract (selection, follow mode, iteration
  navigation, details toggle, raw escape, quit, merge) becomes a
  documented part of the TUI's observable behavior.
- **NEW** `run-tui` capability — defines the TUI's event-reducer
  contract (the pure function that maps `NodeEvent` streams into
  per-node `RunState`), the per-event rendering rules (suppress
  system-init and non-rejected rate-limit chatter; render tool_use as
  one-liners; render assistant text as prose; details mode for full
  JSON), the layout (top header, left status pane, right log pane,
  bottom hotkey bar), and the hotkey behaviors.
- **NEW** runtime dependency: `ink` (React-for-CLI) plus React as its
  required peer. Locked in `package.json`. Dev-only addition:
  `ink-testing-library` for snapshot and reducer-driven render tests.
- The TUI **does not change the runner**. It is a new consumer of the
  same `onEvent` callback `runFactory()` already exposes; runs.db
  persistence and the existing per-event sink continue to compose.
- On a succeeded terminal status with a non-null `branchName`, the TUI
  SHALL expose an `m` hotkey that invokes `minifac merge` inline (see
  the `merge` subcommand archived in `run-scoped-branches`).

## Capabilities

### New Capabilities

- `run-tui`: the TUI rendering surface for `minifac run` — event
  reducer, log rendering rules, layout components, and hotkey
  behaviors. Lives independently from `run-cli` so the reducer can be
  unit-tested without the CLI argument-parsing surface.

### Modified Capabilities

- `run-cli`: the `minifac run` subcommand grows TUI-default-on
  behavior, `--raw` / `--tui` flags, the auto-fallback rule, and the
  hotkey contract surfaced when stdout is a TTY.

## Impact

- `src/cli.ts` / `src/cli/run.ts` (or wherever the `run` action lives)
  — choose output mode at startup: `--raw` → raw, `--tui` → TUI,
  else `process.stdout.isTTY` → TUI, else raw. Raw mode is the
  existing `onEvent`-to-stdout formatter; TUI mode constructs an
  `InkRunRenderer` and wires it as the `onEvent` consumer.
- `src/tui/` (new directory):
  - `reducer.ts` — pure event reducer + state shape
  - `app.tsx` — root `<RunApp>` component
  - `header.tsx` — top bar
  - `status-pane.tsx` — left pane: per-node rows + glyphs
  - `log-pane.tsx` — right pane: rendered events for selected node
  - `hotkeys.tsx` — bottom bar + `useInput` keyboard handling
  - `spinner.tsx` — Braille spinner
  - `glyphs.ts` — Unicode glyphs + ASCII fallback
  - `event-rendering.ts` — stream-json → `RenderedEvent` mapping
  - `renderer.ts` — `InkRunRenderer` adapter exposing the
    `(entry: NodeEventEntry) => void` callback that the run loop
    feeds; owns the ink `render()` instance lifecycle.
  - `*.test.ts` / `*.test.tsx` files alongside each.
- `package.json` — add `ink`, `react`, `@types/react`; dev-add
  `ink-testing-library`.
- `tsconfig.json` — ensure `jsx: "react-jsx"` (or `react`) covers
  `.tsx` files used by the TUI.
- `biome.json` (or equivalent) — JSX carveout for the new `.tsx`
  files if needed.
- `docs/concepts/Run.md` — mention the TUI default and the `--raw`
  escape hatch.
- `docs/concepts/Run-TUI.md` (new) — layout, hotkeys, log rendering
  rules.
- `README.md` quickstart — call out `--raw` for scripts / CI.
- `examples/sdd.md` quickstart — same callout.

### Out of scope

- **TUI for `minifac serve` / daemon-mode runs.** The daemon already
  has a web viewer; the TUI is for the one-shot CLI case.
- **Brief content panel in the TUI.** The brief is on disk.
- **Mid-run intervention from the TUI.** Pausing a node or sending a
  message to it depends on
  [[0017-Callback-Status-Signaling]] landing first.
- **Sharing TUI state with a remote viewer.** The daemon is the path
  for shareable run inspection.
- **Themes / customization** beyond the Unicode-vs-ASCII glyph
  fallback. Out of scope for v1.
