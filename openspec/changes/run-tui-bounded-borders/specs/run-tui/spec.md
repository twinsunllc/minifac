## MODIFIED Requirements

### Requirement: TUI layout

The TUI SHALL render into a **bounded outer Box** whose
`height` is `Math.max(MIN_TUI_ROWS, Math.floor(terminalRows / 2))`,
where `terminalRows` is the current terminal row count (read
from ink's `useStdout()` or an explicit `rows` prop in tests)
and `MIN_TUI_ROWS` is the minimum bounded height
(equal to today's normal-mode minimum, `24`, and degrading
alongside the existing compact-mode threshold so the TUI still
renders on small surfaces). The TUI SHALL NOT attempt to claim
the full terminal viewport; content above the bounded box
remains visible in the user's normal terminal scrollback.

The TUI SHALL render three vertically stacked **major zones**,
each wrapped in a single bordered Box (border style chosen so
it renders cleanly in ink's default rendering mode — e.g.
`borderStyle="round"` or `borderStyle="single"`), with
`paddingX={1}` inside each border so content does not butt up
against the line:

- **Header zone** (top): one row of content carrying the
  project name (`minifac`), the brief name (or
  `(brief-less)` for brief-less factory runs), the factory
  name, and the currently-active node name. The header
  SHALL update as execution advances.
- **Body zone** (middle): contains the status and log panes.
  When the terminal surface is at least 80 columns by 24
  rows, the body SHALL render the **status pane** on the
  left (one row per node id in declaration order, each
  carrying the node's status glyph, the node id, and — when
  the node has run more than once — an `(n)` suffix showing
  the current iteration), the **log pane** on the right
  (rendered events for the selected `(node, iteration)`
  pair, scrolling independently from the status pane), and
  a **vertical rule** separating the two panes that spans
  the full body height. The status pane retains a fixed-ish
  width (24 columns); the log pane takes the remaining
  body width. When the terminal surface is smaller than
  80×24, the body SHALL collapse to a single-pane layout:
  only the log pane is shown, with the current node's id
  + status glyph prefixed as a header line per log block,
  inside the same bordered body.
- **Hotkey bar zone** (bottom): one row of content carrying
  a compact hint of the currently-available hotkeys.

The body's `height` SHALL be derived from the bounded outer
height minus the header zone's border + content rows and the
hotkey bar zone's border + content rows; the body SHALL pass
its derived height to the log pane as an explicit `height`
prop so the pane's existing scroll/limit logic uses the
right value.

Status glyphs SHALL be:

| Glyph | Meaning |
|-------|---------|
| `○` (dim) | pending — not yet scheduled |
| `◔` (animated) | running — current iteration in flight |
| `●` (green) | most recent iteration succeeded |
| `●` (red) | most recent iteration failed |
| `↻` (yellow) | failed previously, retrying via on_failure |

When the runtime environment does not advertise a UTF-8 locale
(`LANG`, `LC_ALL`, and `LC_CTYPE` together contain no
`UTF-8`/`utf8` substring), the TUI SHALL substitute ASCII
glyphs (e.g. `.` for pending, `*` for running, `o` for
succeeded, `!` for failed, `*` for retrying). The Braille
spinner frames degrade to a rotating ASCII character.

#### Scenario: Outer Box is bounded to half the terminal height

- **WHEN** the TUI is mounted at a terminal size of 120
  columns by 60 rows
- **THEN** the outer rendered Box has `height = 30`
  (`floor(60 / 2)`); content above the bounded box is the
  user's normal terminal scrollback and is not overwritten

#### Scenario: Outer Box clamps to MIN_TUI_ROWS on small terminals

- **WHEN** the TUI is mounted at a terminal size of 80
  columns by 24 rows
- **THEN** the outer rendered Box's `height` is
  `max(MIN_TUI_ROWS, floor(24 / 2)) = MIN_TUI_ROWS` (the
  minimum bounded height), not `12`

#### Scenario: Header, body, and hotkey bar each render inside a bordered Box

- **WHEN** the TUI is mounted at a typical terminal size
  (e.g. 120×40)
- **THEN** the rendered output contains three vertically
  stacked bordered Boxes — header on top, body in the
  middle, hotkey bar on the bottom — each with its own
  border characters and `paddingX={1}` inside

#### Scenario: Body shows status and log panes separated by a vertical rule

- **WHEN** the TUI is mounted at a typical terminal size
  (e.g. 120×40) with multiple factory nodes
- **THEN** the body zone renders the status pane on the
  left (fixed-ish width 24), the log pane on the right
  (flex-grow), and a vertical rule separating them that
  spans the full body height

#### Scenario: Top header shows brief, factory, current node

- **WHEN** the TUI is mounted for a run whose brief change is
  `foo`, whose factory is `sdd`, and whose currently-running
  node is `verify`
- **THEN** the top header includes the strings `minifac`,
  `foo`, `sdd`, and `verify`

#### Scenario: Top header on brief-less factory runs

- **WHEN** the TUI is mounted for a brief-less factory
  invocation of `hello`
- **THEN** the top header includes the string `(brief-less)`
  and the factory name `hello`

#### Scenario: Iteration count appears as (n) suffix

- **WHEN** node `verify` is on its third iteration
- **THEN** the status pane row for `verify` includes the
  suffix `(3)`

#### Scenario: Glyphs degrade to ASCII without UTF-8

- **WHEN** the TUI is mounted with environment variables
  `LANG=C`, `LC_ALL=C`, `LC_CTYPE=C`
- **THEN** the rendered status glyphs and spinner frames are
  drawn from the ASCII fallback set, not the Unicode set

#### Scenario: Sub-80x24 collapses body to a single log pane inside the bordered shape

- **WHEN** the TUI is mounted at a terminal size of 60×20
- **THEN** the body zone contains only the log pane (no
  status pane, no vertical rule); each log block is
  prefixed by the current node's id and status glyph; the
  header and hotkey bar zones still render as bordered
  Boxes above and below the body
