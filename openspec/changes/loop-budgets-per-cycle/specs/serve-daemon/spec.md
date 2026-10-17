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
event. They are held in the daemon's in-memory buffer and are not written
to the run store.

#### Scenario: An uncovered cycle reaches the response and the event stream

- **WHEN** a client starts a run of a watched factory whose loader
  returned one `uncovered_cycle` warning
- **THEN** the `201` body's `warnings` holds that one warning
- **AND** the first event replayed on `GET /api/runs/:id/events` is a
  `stderr` event from `__runner__` whose line starts `warning: ` and
  names the factory file

#### Scenario: A fully capped factory has no warnings

- **WHEN** a client starts a run of a factory with no load warnings
- **THEN** the `201` body's `warnings` is `[]`
- **AND** the run's events carry no `__runner__` warning event
