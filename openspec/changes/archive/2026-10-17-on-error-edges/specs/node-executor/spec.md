## ADDED Requirements

### Requirement: Terminal status outcome

A terminal `status` event MAY carry `outcome`, a `NodeOutcome`. An
executor SHALL set `outcome: "error"` on a `failed` status when it
could not produce a judgment, and SHALL NOT set it on a judged
failure. Absent means `success` for `succeeded` and `failure` for
`failed` (ADR 0052).

The built-in executors SHALL map as follows:

- `claude`: `error` for `invalid_with`, `spawn_error` and
  `missing_binary`, and, when no `MINIFAC_STATUS` sentinel matched, for
  a non-zero or `null` exit code or a final stream-json `result` event
  with `is_error: true`. The `is_error` case SHALL be `failed` even on
  exit `0`, and SHALL carry the result's `subtype` as `meta.subtype`
  when it has one. A matched `MINIFAC_STATUS: failed` is a failure
  whatever the exit code. Exit `0` with no sentinel and no `is_error`
  stays `succeeded`.
- `command`: `error` for `invalid_with`; for a red command with no exit
  code (`host_missing`, a spawn error, ended by a signal); for a red
  command that timed out or was aborted, whatever code it exited with;
  and for a `result_parse` failure. One such command makes the node an
  error under `continue_on_red`. A command that exited outside its
  `expect.exit` is a failure.
- `check-merge`: `error` for `invalid_with`, `missing_base`,
  `missing_base_ref` and `git_error`; `merge_conflict` and
  `fast_forward_required` are failures.

#### Scenario: claude exit 1 with no sentinel

- **WHEN** the child exits `1` and no `result` event carries a sentinel
- **THEN** the final event is `{ status: "failed", meta: { exitCode: 1 },
  outcome: "error" }`

#### Scenario: claude rate limit

- **WHEN** the final `result` event has `is_error: true` and no sentinel
- **THEN** the final event is `failed` with `outcome: "error"`

#### Scenario: claude judged failure

- **WHEN** the final `result` text carries `MINIFAC_STATUS: failed` and
  the child exits `1`
- **THEN** the final event is `failed` with `reason: "sentinel_failed"`
  and no `outcome`

#### Scenario: command timeout

- **WHEN** a command exceeds `timeout_seconds`
- **THEN** the node's final event is `failed` with `outcome: "error"`

#### Scenario: command unmet expect

- **WHEN** a command exits `1` with `expect.exit: 0` and nothing else is
  red
- **THEN** the node's final event is `failed` with no `outcome`

#### Scenario: check-merge git error versus conflict

- **WHEN** `git merge-tree` exits outside `0`, `1` and `128`
- **THEN** the final event is `failed`, `reason: "git_error"`,
  `outcome: "error"`; a `merge_conflict` carries no `outcome`
