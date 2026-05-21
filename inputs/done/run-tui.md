---
change: run-tui
factory: sdd
base_branch: main
---

## Background

`minifac run` today prints line-prefixed stream-json straight to
stdout. Lossless and pipe-friendly, but unreadable as an
interactive experience — a non-trivial run is hundreds of opaque
JSON lines with no sense of where execution sits in the
topology.

The binding decision is captured at
`docs/decisions/0021-Run-TUI.md`. Read it first. Key design
calls already locked there:

- TUI is the **default** when stdout is a TTY; auto-fallback to
  raw (today's output) when not. `--tui` / `--raw` override.
- Two-pane layout: status pane (left) + logs pane (right) + top
  header (brief/factory/current node) + bottom hotkey bar.
- One row per node id in the left pane (not per iteration).
  Iteration count as `(n)` suffix; `<` / `>` to navigate prior
  iterations.
- Default selection follows the running node; user input pauses
  follow mode; `Enter` resumes.
- Log presentation: parsed and rendered per event type. Tool
  calls become one-liners; assistant text rendered as prose;
  system / rate-limit noise suppressed by default. `d` key
  expands full JSON for the highlighted event.
- Library: **`ink`** (React for CLI). One new runtime dep, locked.
- On run completion: TUI stays open; `m` hotkey invokes
  `minifac merge <change>` inline.

## What to do

Implement what 0021 describes. Concretely:

### 1. Detect mode

- In `src/cli.ts` (or wherever `minifac run` dispatches), choose
  output mode at startup:
  - `--raw` → raw mode
  - `--tui` → TUI mode (force, even on non-TTY)
  - else if `process.stdout.isTTY` → TUI mode
  - else → raw mode
- Raw mode is the existing `onEvent`-to-stdout formatter from
  today, unchanged.
- TUI mode constructs an `InkRunRenderer` (described below) and
  wires it as the `onEvent` consumer for `runFactory()`.

### 2. Add `ink` and dev test helpers

- `npm install ink react @types/react`
- `npm install -D ink-testing-library`
- biome may complain about JSX — add a small biome override or
  `.tsx` carveout per the existing config patterns.
- TypeScript: confirm `tsconfig.json` covers JSX via `jsx:
  "react"` or `react-jsx`.

### 3. Event reducer

- `src/tui/reducer.ts` exposes a pure reducer that takes the
  TUI's current state and an event, returning new state.
- TUI state shape (sketch):

      type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "retrying";

      interface NodeState {
        id: string;
        status: NodeStatus;
        iteration: number;            // 1-based; 0 when never run
        iterations: IterationLog[];   // one per (node, iteration) pair
        terminal: boolean;
      }

      interface IterationLog {
        iteration: number;
        events: RenderedEvent[];
        terminalStatus?: "succeeded" | "failed";
        terminalReason?: string;
      }

      interface RenderedEvent {
        kind: "text" | "tool_use" | "tool_result" | "status" | "raw";
        summary: string;       // one-line human-readable
        fullJson?: string;     // present for `d` (details) mode
        rawNodeEvent?: NodeEvent;
      }

      interface RunState {
        brief?: { change: string };
        factory: { name: string };
        nodes: NodeState[];        // declaration order
        selectedNodeId: string;
        selectedIteration: number; // 1-based
        followMode: boolean;       // true = auto-advance
        terminalStatus?: "succeeded" | "failed";
      }

- Reducer cases: handle `stdout` / `stderr` / `status` events.
  Parse each `stdout` line (which is itself a stream-json event)
  and produce a `RenderedEvent`.
- Event-type rendering rules per 0021's "Log cleanup" section:
  suppress system init + rate-limit-allowed events; render
  tool_use as `→ ToolName(short args)`; render tool_result as
  `✓ result` or `✗ error`; render assistant text as the text
  itself; render synthetic status events with a glyph.

### 4. Ink components

- `src/tui/app.tsx` — root `<RunApp>` component
- `src/tui/header.tsx` — top bar
- `src/tui/status-pane.tsx` — left pane: list of nodes with
  glyphs
- `src/tui/log-pane.tsx` — right pane: rendered events for the
  selected (node, iteration)
- `src/tui/hotkeys.tsx` — bottom bar + keyboard input handling
  via ink's `useInput`
- `src/tui/spinner.tsx` — small Braille spinner for the running
  state glyph
- `src/tui/glyphs.ts` — Unicode glyphs + ASCII fallbacks based
  on a runtime check for UTF-8 support (env var `LANG` or
  similar; ink may expose this)

Render targets minimum terminal size of 80×24. Smaller surfaces
fall back to a single-pane mode (log pane only, with status as
inline prefix). Document that in the help overlay.

### 5. Hotkeys

Bind via ink's `useInput`:

- `↑` `↓` `j` `k` — move selection in status pane; sets
  `followMode = false`
- `Enter` — `followMode = true`; select currently-running node
- `PgUp` `PgDn` — scroll log pane
- `<` `>` — previous/next iteration of selected node
- `d` — toggle details (full JSON) for currently-highlighted
  log line
- `r` — switch to raw mode for the remainder of the run
- `q` — quit. If run is still in flight, confirm; on confirm,
  kill child process and exit non-zero with a clear "user
  quit" reason in runs.db
- `m` — only when run is in a `succeeded` terminal state.
  Invokes `minifac merge <change>` (or `<run-id>` for
  brief-less). Surfaces output inline (in a small popup
  overlay) and returns to the TUI with the merge result.
- `?` — toggle help overlay

### 6. Run completion behavior

- On terminal status (succeeded / failed):
  - All node glyphs settle to final colors
  - Top bar shows final status + reason if failed
  - Bottom bar updates to `Run finished (<status>). Press q to
    quit[, m to merge]`
  - `m` is only present in the hint when succeeded AND the run
    has a non-null `branch_name` (i.e. it's mergeable)
- The TUI does not auto-exit. User presses `q` to leave.

### 7. Tests

Use `ink-testing-library` for snapshot tests.

- Render an `<RunApp>` with synthetic state at key moments:
  - Initial (all pending)
  - One node running (spinner showing)
  - All nodes succeeded
  - One node failed, retry in progress
  - Run terminated, succeeded
  - Run terminated, failed
- Reducer unit tests for each event type → expected state
  transition.
- Hotkey tests: simulate arrow / Enter / PgUp/PgDn etc., assert
  state updates.
- Auto-fallback test: when `stdout.isTTY` is false, assert raw
  mode is used.
- `--raw` and `--tui` flag tests.
- All existing tests still pass.

### 8. Specs

- `run-cli`: MODIFIED requirement for the `run` subcommand to
  describe the default TUI mode, the `--raw` / `--tui` flags,
  the auto-fallback rule, and the hotkey contract. ADDED
  scenario(s) for each hotkey's observable behavior.
- NEW capability `run-tui` (or fold into `run-cli` — your
  judgment) covering the event-reducer contract, the rendering
  rules per event type, and the layout components. Tests cover
  the reducer scenarios.

When MODIFYING, copy the entire requirement block; do not
partial-paste.

### 9. Documentation

- Update `docs/concepts/Run.md` to mention the TUI briefly +
  the `--raw` escape hatch.
- New `docs/concepts/Run-TUI.md` (optional — your judgment) or
  a section inside `Run.md` describing the layout, hotkeys, and
  log-rendering rules.
- README quickstart update: mention `--raw` for scripts and
  CI; default is TUI.
- `examples/sdd.md` quickstart update.

## Out of scope

- **TUI for `minifac serve` / daemon-mode runs.** The daemon
  already has the web viewer; the TUI is for the one-shot
  CLI case. If the user wants to observe daemon runs from the
  terminal, that's a future enhancement.
- **Brief content panel in the TUI.** The brief is on disk;
  showing it in the TUI is nice-to-have, not v1.
- **Mid-run intervention from the TUI.** Pausing a node, sending
  a message to it — that depends on
  [[0017-Callback-Status-Signaling]] (callback transport)
  landing first.
- **Sharing TUI state with a remote viewer.** TUI is local; the
  daemon is the path for shareable run inspection.
- **Themes / customization beyond UTF-8 vs ASCII glyph
  fallback.** Out of scope for v1.

## Acceptance criteria

- `minifac run <brief>` in a TTY shows the TUI by default
- `minifac run <brief> > log` (non-TTY) falls back to raw output
  with no behavior change vs today
- `--raw` flag forces raw output even in a TTY
- `--tui` flag forces TUI output even in a non-TTY (test only)
- Status pane shows one row per node, glyph reflects current
  status, iteration count surfaces as `(n)` for cycling
- Selecting a node with arrows shows that node's logs
- `Enter` resumes follow mode
- `<` / `>` cycle through prior iterations for cycling nodes
- `d` toggles full-JSON details for the highlighted log event
- `r` switches to raw output for the remainder of the run
- `q` quits; if mid-run, prompts for confirmation; on confirm,
  child process is killed and the run is recorded with an
  appropriate failure reason
- `m` (on succeeded run) invokes `minifac merge` inline and
  shows the result
- Snapshot tests cover the key render states
- Reducer unit tests cover each event type
- All existing 357+ tests still pass
- New runtime dep (`ink` + React) declared in package.json;
  install + build pass cleanly
