---
tags: [concept]
aliases: [run-tui, tui]
---

# Run-TUI

The interactive terminal surface for `minifac run`. When stdout is a
TTY, this is the default; for pipes, redirects, and CI the command
falls back to the raw line-prefixed output. See [[Run]] for the
mode-detection rules and the `--raw` / `--tui` overrides.

## Layout (≥ 80 × 24)

The TUI renders into a **bounded** outer Box at the bottom of the
terminal — `height = max(MIN_TUI_ROWS, floor(terminalRows / 2))`.
Content above the bounded box is the user's normal terminal
scrollback; the TUI never claims the full viewport. This is the
lever that removes the rolling-overdraw flicker the unbounded
layout produced on long log-emitting runs.

Three vertically stacked **bordered zones** carry the layout —
header, body, hotkey bar — each wrapped in a single rounded-border
Box. Inside the body, the status pane and log pane are separated
by a vertical rule.

```
╭───────────────────────────────────────────────────────────────╮
│ minifac · brief: <change|(brief-less)> · factory: <name> · …  │
╰───────────────────────────────────────────────────────────────╯
╭───────────────────────────────────────────────────────────────╮
│ ▸ ◔ propose       │ → Bash({"command":"npm test"})            │
│   ● apply (2)     │ ✓ test output line                        │
│   ○ verify        │ ...                                       │
╰───────────────────────────────────────────────────────────────╯
╭───────────────────────────────────────────────────────────────╮
│ ↑/↓ nav · Enter follow · < > iter · d details · r raw · ? … │
╰───────────────────────────────────────────────────────────────╯
```

- **Top header** — project name, brief change (`(brief-less)` for
  brief-less factories), factory name, currently-active node, and
  (on terminal) the final status.
- **Left status pane** — one row per node id, in declaration
  order. Each row carries:
  - a status glyph (pending `○`, running spinner, succeeded `●`
    green, failed `●` red, retrying `↻`),
  - the node id,
  - an `(n)` iteration suffix when the node has run more than once,
  - a selection marker (`▸`) on the row the user is focused on.
- **Right log pane** — the rendered events for the selected
  `(node, iteration)` pair, scrolled and highlighted independently
  of the status pane.
- **Bottom hotkey bar** — a compact hint of currently-available
  hotkeys. `m merge` is advertised only on a succeeded terminal
  status whose run row carries a non-null `branchName`.

## Log rendering rules

The TUI parses each stdout line as a stream-json event from the
executor and renders it:

| Event type                             | Default render                  |
|----------------------------------------|---------------------------------|
| `system / init`                        | suppressed                      |
| `rate_limit_event` (status ≠ rejected) | suppressed                      |
| `rate_limit_event` (rejected)          | highlighted line with reason    |
| `assistant / text`                     | prose                           |
| `assistant / tool_use`                 | `→ Tool(short args)`            |
| `user / tool_result` (ok)              | `✓ <first non-empty line>`      |
| `user / tool_result` (error)           | `✗ <first non-empty line>`      |
| `result`                               | terminal-status line            |
| synthetic `status` (from runner)       | highlighted line with glyph     |
| unparseable line                       | raw text                        |

`d` toggles a "details" mode on the highlighted log line that
pretty-prints the full JSON in place.

## Hotkeys

| Key(s)            | Behavior |
|-------------------|----------|
| `↑` / `↓` / `j` / `k` | Move selection in the status pane; pauses follow mode |
| `Enter`           | Resume follow mode; jumps to the running node |
| `PgUp` / `PgDn`   | Scroll the log pane |
| `<` / `>`         | Previous / next iteration of the selected node |
| `d`               | Toggle full JSON for the highlighted log line |
| `r`               | Switch to raw output for the rest of the run (TUI unmounts) |
| `q`               | Quit. Mid-run shows `[y/N]` confirmation; on confirm the run is cancelled and the failure recorded as `reason: user_quit` |
| `m`               | (Only when the run is succeeded AND `branchName != null`) invoke `minifac merge` inline |
| `?`               | Toggle help overlay |

## Sub-80×24 fallback

Below 80 columns or 24 rows, the status pane is hidden; the log
pane fills the surface with the current node's id and status glyph
prefixed as a header line. The help overlay (`?`) documents this.

## ASCII / UTF-8 glyph fallback

When `LANG`, `LC_ALL`, and `LC_CTYPE` together do not advertise
`UTF-8`/`utf8`, the TUI substitutes an ASCII glyph set (`. * o !
*`) and the spinner degrades to a rotating ASCII character.

## Related

- [[Run]] — the underlying concept and persistence
- [[0021-Run-TUI]] — the architectural decision that pins this
  surface
- [[0022-Run-TUI-Bounded-Borders]] — the layout decision that
  added the bounded outer height and bordered + ruled zones
- [[Runner]] — the event source the TUI consumes
