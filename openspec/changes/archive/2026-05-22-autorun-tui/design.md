## Context

The archived `run-tui` change introduced a pure event reducer
(`src/tui/reducer.ts`), an ink renderer adapter
(`src/tui/renderer.tsx`), and a default-on TUI for `minifac run`
when stdout is a TTY. That surface accepts the `NodeEventEntry`
stream `runFactory()` emits and renders header / status pane /
log pane / hotkey bar inside a bounded, bordered outer box.

`minifac autorun` (per the `auto-mode` capability) is a poll loop
that schedules ready briefs against the same run primitive
`minifac run` invokes. Today it emits one log line per scheduling
event (`poll-start`, `started`, `skipped`, `completed`, `failed`,
`dry-run-decision`) via a `makeLogger(io, json)` helper. The
events themselves are well-shaped already — `AutorunEvent` is a
discriminated union in `src/cli/autorun.ts` — so the existing
event stream is the right input for a TUI without having to
re-derive state from disk.

The task: build a TUI for autorun that mirrors the run-mode TUI's
shape (default-on in a TTY, `--raw` / `--tui` precedence, bordered
zones, hotkey bar), with a left brief-list pane replacing what
would be the status pane in run-mode. Drilling into a brief
shows the embedded run-mode view for that brief's most recent
run; drilling further into a node shows its log stream, exactly
as run-mode already does.

## Goals / Non-Goals

**Goals:**

- `minifac autorun` in a TTY shows the autorun TUI by default;
  pipes / CI keep working unchanged (raw / JSON output unchanged).
- `--raw` and `--tui` flags override mode detection per the same
  precedence rule run-mode uses.
- One row per brief in the brief-list pane, with a status glyph
  reflecting the brief's autorun state (queued, running,
  succeeded, failed, skipped — *not* the brief's
  doneness/activity, which is the file-system view).
- Selecting a brief drills into the existing run-mode TUI for
  that brief's current (or most recent) run; that surface is the
  one already shipped by `run-tui`.
- Selecting a node within the embedded run-mode view shows its
  log stream — same behavior as `minifac run`.
- New code is limited to: the brief-list reducer, the brief-list
  pane component, the route/selection wiring, the autorun
  renderer adapter, and the CLI plumbing.
- Tests cover the brief-list reducer (mirror
  `src/tui/reducer.test.ts`) and the precedence resolver
  (mirror `src/cli.tui.test.ts`).

**Non-goals:**

- Filters, brief-level cancel/retry from the TUI, or any other
  *new* autorun feature.
- Removing `minifac serve`. That's a future decision.
- Re-rendering the run-mode TUI from scratch. The embedded
  view reuses the existing `<RunApp>` and `runReducer` surface.
- Brief content rendering. The brief is on disk; the TUI is for
  status, not content.

## Decisions

### Brief-list reducer is its own pure function

The autorun TUI introduces a second pure reducer
(`autorunReducer`) that operates on a `BriefListState`. This
state is independent of the per-run `RunState` the existing
`runReducer` already owns. Brief-list events are a discriminated
union of:

- Run events: every `AutorunEvent` produced by the autorun
  process (already a discriminated union in `src/cli/autorun.ts`).
  `poll-start` updates the observed-brief set; `started` /
  `completed` / `skipped` / `failed` / `dry-run-decision` update
  the corresponding brief's status.
- UI events: `select-brief-next`, `select-brief-prev`,
  `enter-brief`, `back-to-list`, `request-quit`, `confirm-quit`,
  `cancel-quit`, `toggle-help`.

The reducer is pure and unit-testable in isolation, the same way
`runReducer` is. This is the surface tests target — not the ink
components.

**Why pure-reducer:** the existing run-mode TUI already won the
"pure reducer + thin ink renderer" architecture once. Pattern-
matching this for autorun keeps the test surface uniform (every
TUI in the repo unit-tests through its reducer; ink trees are
covered with snapshot tests separately) and avoids inventing a
second architecture for what is structurally the same problem.

**Rejected:** a single combined reducer covering both brief-list
state and per-run state. The two are independent: a brief is
"queued" / "running" / "succeeded" / "failed" / "skipped" purely
on autorun events; a run's nodes are pending / running / etc.
purely on `NodeEventEntry` events. Coupling them would create a
giant state union with two sets of UI events; keeping them
separate lets the embedded run-mode view reuse `runReducer`
verbatim.

### Brief states map to status glyphs

The brief-list reducer's `BriefStatus` discriminated union:

- `queued` — observed in the watch dir, not yet scheduled (e.g.
  blocked by deps, throttled by concurrency, or just hasn't been
  picked up by the next poll). Glyph: `○` (dim).
- `running` — autorun emitted a `started` event for it; no
  `completed` event yet. Glyph: `◔` (animated spinner, reusing
  the existing run-mode spinner).
- `succeeded` — most recent `completed` event had
  `status: "succeeded"`. Glyph: `●` (green).
- `failed` — most recent `completed` event had
  `status: "failed"` OR a primitive-level `failed` event
  arrived. Glyph: `●` (red).
- `skipped` — most recent event for this brief was a `skipped`
  event. Glyph: `↷` (dim). Note that `skipped` is *not* terminal
  — the same brief can be re-evaluated next poll and transition
  back to `queued` or onward.

`dry-run-decision` events translate to `queued` (action
`schedule`) or `skipped` (action `skip`) for the purposes of the
brief-list. In `--dry-run` mode there is no terminal state.

The glyph fallback (Unicode → ASCII when the locale doesn't
advertise UTF-8) reuses `src/tui/glyphs.ts`. The brief-list
glyphs are added to the existing set rather than diverging into
a parallel set.

**Why use the same glyphs run-mode uses for its nodes:** the user
visual vocabulary in this repo is `○ / ◔ / ●` (with color
encoding success vs. failure). Inventing a new set for briefs
would be confusing; reusing it makes the relationship "a brief
is a higher-level node" visually obvious.

### Layout mirrors run-mode

Three vertically stacked bordered zones inside a bounded outer
Box, exactly like run-mode:

- **Header zone** — `minifac autorun · watch=<dir> ·
  in-flight=<n>/<max-concurrent>` plus, when a brief is entered,
  the run-mode header content for that brief (already produced
  by the existing `<Header>` component).
- **Body zone** — the brief-list pane (24 cols, fixed-ish) on
  the left, separated by a vertical rule from the embedded
  run-mode view (the existing `<StatusPane>` + log pane). When
  no brief is selected (the empty-state on first launch), the
  right side renders a one-liner hint ("Press ↓/↑ to select a
  brief, Enter to drill in") instead of a run view.
- **Hotkey bar zone** — bottom row with current-context hotkey
  hints. When the brief-list is focused: `↑/↓ select · Enter
  drill in · r raw · q quit`. When a brief is entered (focus
  moved to the embedded run view): `↑/↓ select node · Esc back
  to briefs · r raw · q quit` plus whatever the embedded
  run-mode view already advertises (e.g. `m merge`).

The bounded outer Box, the bordered zones, the
`MIN_TUI_ROWS` clamp, the `paddingX={1}` inside each border, and
the sub-80×24 collapse rules are all inherited from run-mode and
not re-specified here. The autorun TUI inherits them because it
uses the same outer Box / zone components.

**Why two-level navigation (brief → run → node) rather than a
flat list of every node across every run:** at any non-trivial
scale a flat node list would not fit on screen and would mix
nodes from unrelated runs. Two levels also matches the user's
mental model — "show me brief foo's run, then within it the
verify node" — and lets us reuse `<RunApp>` unchanged on the
right side.

### Mode selection mirrors run-mode

`pickOutputMode` already exists in `src/cli.ts` and encodes the
exact precedence we want: `--raw` > `--tui` > `isTTY` > raw. We
reuse it; the only autorun-specific additions are:

- `--tui` combined with `--json` is a usage error
  (the JSON contract is a machine-readable stream; you can't
  also mount a TUI on the same stdout).
- `--dry-run` + `--tui` is allowed: the TUI mode still renders
  the brief-list with each brief's `dry-run-decision` (action
  `schedule` → queued glyph; action `skip` → skipped glyph),
  then exits when the single dry-run cycle drains. Most callers
  of `--dry-run` will pipe / redirect anyway, so this is rarely
  hit, but we don't refuse it.
- `--once` + `--tui` is allowed: the TUI stays mounted until the
  user presses `q` (matching run-mode's "doesn't auto-exit on
  completion" rule). This is the babysit case the change is
  motivated by.

**Why not `--json` + `--tui` allowed:** the run-mode TUI doesn't
have an equivalent JSON output stream, so there's no conflict
there. Autorun's `--json` is documented as a machine-readable
contract; producing both is asking for trouble. Refusing the
combination keeps the contract clean.

### TUI subscribes to the same event sources

The autorun TUI is a passive consumer:

- It subscribes to `AutorunEvent` callbacks the way the existing
  human/JSON logger does. The scheduler's callback API
  (`onStarted`, `onCompleted`, `onError`) is unchanged.
- For the embedded run-mode view, it subscribes to
  `NodeEventEntry` events from the per-brief run primitive.
  Today the autorun process does NOT plumb per-event callbacks
  through to its scheduler — it only gets terminal status back
  from the run primitive. The TUI work surfaces a small
  extension: `AutorunRunFactory` may optionally invoke an
  `onRunEvent(NodeEventEntry)` callback for the brief's current
  run. The default `buildDefaultRunFactory` already has access
  to the run primitive's `onEvent`; threading it through is
  mechanical.

**Why pass `onRunEvent` rather than reading from the run store:**
two reasons. First, it matches the run-mode TUI's contract — the
TUI consumes the same callback the run primitive already emits,
not a derived view. Second, polling the run store would make the
brief-list view "almost live" with an arbitrary lag; the existing
`runs show --follow` already covers the "tail from the store"
use case, and conflating the two would muddy this change.

### Persistence and shutdown semantics are unchanged

The TUI does not change autorun's persistence (runs.db), signal
handling (SIGINT/SIGTERM drain or escalate), lockfile claims,
worktree creation, or the poll loop. On TUI exit (`q`):

- If the user quits while runs are in flight: the same
  graceful-shutdown path the SIGINT handler runs is invoked
  (stop scheduling, drain in-flight runs, exit `0`). Per
  in-flight run is not abandoned.
- After unmount, the same final-summary stderr lines the
  existing autorun emits are written, so scripts that grep
  `[run]` / `completed` lines from stderr keep working when
  stderr is piped.

**Why drain rather than escalate on `q`:** autorun's existing
contract is that the first signal drains. A user pressing `q`
on a TUI is the moral equivalent of a first SIGINT — they want
to stop, but they don't want to lose in-flight work. Power
users who want to kill children immediately have `--force` (the
same flag the headless path uses) and a `Ctrl-C` always escapes
ink.

## Risks / Trade-offs

- **Two reducers to maintain.** The codebase now has
  `runReducer` (per-run) and `autorunReducer` (brief-list).
  Acceptable: the two own genuinely different state. The
  brief-list reducer is small (one row per change, ~5 states).
- **The embedded run-mode view's lifecycle.** When the user
  switches between briefs, the embedded `<RunApp>`'s per-run
  state must reset to the new brief's per-run state. This is a
  one-line concern in the autorun renderer adapter
  (re-`render()` with the new brief's `RunState`), but it's
  worth calling out: each brief in `BriefListState` carries its
  own `RunState` slot so the embedded view's state is rehydrated
  per selection, not lost on switch.
- **Per-event callback plumbing.** Adding `onRunEvent` to the
  `AutorunRunFactory` shape is a small extension; existing
  callers (tests) that don't supply it pass through unchanged.
- **Stdin handling overlap.** Both run-mode and autorun-mode
  TUIs grab stdin via ink's `useInput`. There's only one TUI
  mounted at a time (the embedded run view is a child of the
  autorun TUI's ink tree, not a separate ink instance), so
  input flows through one `useInput` chain and the autorun TUI
  routes keys based on focus state (brief-list vs. drilled-in).
- **`--json` + TTY combination.** A user invoking
  `minifac autorun --json` from a TTY today gets JSON on stdout.
  After this change, default behavior in a TTY is the TUI, so
  the user MUST pass `--raw` (or get the implicit raw fallback
  when stdout is not a TTY) to get JSON. We surface this as a
  usage error rather than silently winning one way: `--json` in
  a TTY without `--raw` (and without `--tui`) is treated as an
  implicit `--raw` (the JSON stream wins, no TUI is mounted).
  `--json --tui` is the explicit usage error. This preserves
  scripts that set `--json` and pipe in CI (where stdout isn't
  a TTY anyway) and keeps the TTY behavior unsurprising.

## Migration Plan

No data or schema migration. The change is additive:

- The autorun event stream is the same shape it already is.
- The runs.db rows are the same.
- The CLI grows two flags (`--raw`, `--tui`) on the `autorun`
  subcommand. Default behavior in a TTY is the TUI; default
  behavior in a non-TTY is unchanged (raw text). CI pipelines
  redirecting stdout get raw output for free.
- Existing scripts that do not pass `--json` and that run on a
  TTY interactively will see the new TUI on next invocation.
  Anyone who wants the old behavior runs with `--raw`.

The capability spec documents the precedence so the new
behavior is discoverable.

## Open Questions

- Should brief rows show their dep status (e.g. "blocked by
  bar") as a secondary line, or only their autorun-side state?
  Current decision: only the autorun-side state, to keep one
  row per brief. Operators who need the dep view can
  `minifac briefs` or use `--dry-run`.
- When `--dry-run` is combined with `--tui`, should the TUI
  auto-exit on dry-run cycle drain, or stay mounted until `q`?
  Current decision: auto-exit, because there's nothing more to
  watch — no events arrive after the single cycle. (Run-mode
  doesn't auto-exit because a real run still wants the operator
  to read the result; a dry-run cycle is essentially instant.)
