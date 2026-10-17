## ADDED Requirements

### Requirement: Runs carry the factory's load warnings

When `POST /api/runs` starts a run, its `201 Created` body SHALL carry,
besides `id`, `factoryId`, `status` and `startedAt`, a `warnings` array:
the factory's load warnings (`FactoryLoadWarning`, per the
`factory-schema` capability's "Cycle budgets are mandatory" requirement),
empty when it has none. The field is additive; no other field changes.

The run registry SHALL open the run's event log with one event per load
warning, before any event the runner emits: `nodeId` `__runner__`,
`iteration` `0`, kind `stderr`, and the line `formatFactoryLoadWarning`
produces (`warning: <sourcePath>: <message>`). These events SHALL be
delivered and replayed over the run's SSE stream like any other buffered
event. They SHALL also be written to the run store as the run's first
events, before any event the runner emits, so a daemon restarted on the
same `runs.db` replays them when it reads the run back. Each is stored
once: the daemon puts it in its in-memory buffer when the run starts, and
the runner writes it to the store without emitting it again.

#### Scenario: An uncovered cycle reaches the response and the event stream

- **WHEN** a client starts a run of a watched factory whose loader
  returned one `uncovered_cycle` warning
- **THEN** the `201` body's `warnings` holds that one warning
- **AND** the first event replayed on `GET /api/runs/:id/events` is a
  `stderr` event from `__runner__` whose line starts `warning: ` and
  names the factory file

#### Scenario: A restarted daemon replays the warnings from the run store

- **WHEN** a run of a factory with one `uncovered_cycle` warning has ended
- **AND** a new daemon process opens the same `runs.db` and reads the run
- **THEN** the run's first event is the `__runner__` `stderr` event whose
  line starts `warning: ` and names the factory file
- **AND** that event appears exactly once

#### Scenario: A fully capped factory has no warnings

- **WHEN** a client starts a run of a factory with no load warnings
- **THEN** the `201` body's `warnings` is `[]`
- **AND** the run's events carry no `__runner__` warning event
