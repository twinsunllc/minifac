## ADDED Requirements

### Requirement: Autorun TUI shows factory load warnings

In TUI output mode, autorun SHALL deliver each `load-warning` event to the
TUI renderer as well as to the (suppressed) human / JSON logger. The
brief-list reducer SHALL keep each load warning, formatted with
`formatFactoryLoadWarning`, in `BriefListState.loadWarnings`, once however
many runs report it, in arrival order. The brief-list pane SHALL draw the
kept warnings below the brief rows.

#### Scenario: An uncovered cycle is shown in the TUI

- **WHEN** autorun runs in TUI output mode and a brief's factory loads
  with an `uncovered_cycle` warning
- **THEN** the renderer receives the `load-warning` event
- **AND** the brief-list pane shows `warning: <factory path>: <message>`
- **AND** nothing is written to stdout by the human / JSON logger

#### Scenario: A warning is kept once

- **WHEN** two briefs sharing the factory each report the same warning
- **THEN** `loadWarnings` holds it once
