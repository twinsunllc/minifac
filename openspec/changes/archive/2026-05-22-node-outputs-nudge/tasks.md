## 1. Factory schema — `output_nudge_budget`

- [x] 1.1 Extend the node shape in `src/factory/schema.ts` with
      `output_nudge_budget: z.number().int().nonnegative()
      .optional().default(1)`. The field SHALL be optional at
      the YAML surface but populated with `1` on the resolved
      node when absent.
- [x] 1.2 Extend the node-level accepted-key-set validator (the
      strict-on-extras layer that already enumerates
      `executor`, `with`, `uses`, `inputs`, `terminal`,
      `max_iterations`, `cwd`, `outputs`) to include
      `output_nudge_budget`.
- [x] 1.3 Mirror the field in `src/factory/types.ts` (or
      wherever the node-level resolved-type definition lives)
      so the runner can read it through the existing typed
      node shape.
- [x] 1.4 Confirm `extends:` merging preserves
      `output_nudge_budget` per the existing
      replace-at-node-level semantics (the whole node is
      replaced; no field-level merging). Add a test asserting
      the field round-trips through extends.
- [x] 1.5 Tests in `src/factory/schema.test.ts` covering each
      scenario in the factory-schema delta's
      "`output_nudge_budget` per-node field" requirement.

## 2. Runner — nudge helper

- [x] 2.1 Create `src/runner/nudge.ts` exporting
      `buildNudgeMessage(missing: MissingOutput[]): string`
      and the `MissingOutput` type
      (`{ key: string; type: "value" | "file" | "directory";
      expected_path: string; detail?: string }`).
- [x] 2.2 Implement the message construction per the design
      doc's canonical format: header line ("The following
      declared required outputs were not produced:"), one
      bullet per missing key naming key + type + expected
      path (+ detail when present and non-trivial), closing
      paragraph instructing the model to produce the outputs
      and emit `MINIFAC_STATUS: succeeded` (or `failed` with
      a `REASON`).
- [x] 2.3 Tests in `src/runner/nudge.test.ts` covering:
      single-missing-output, multi-missing-output, all three
      output types in the same list, detail strings
      (parse-error, ambiguous, empty), and the no-detail
      collapse for the common "absent" case.

## 3. Executor — stdin write capability

- [x] 3.1 Add `supportsNudge: boolean` to the `Executor`
      capability flag set in `src/executor/types.ts`
      (alongside the existing `supportsMcp` flag). Default
      `false`; the Claude executor SHALL set `true`.
- [x] 3.2 Verify (with a manual stream-json reproduction
      against the real `claude` CLI) that writing a
      user-message event to stdin after a `result` event does
      in fact produce a new turn of events. If the current
      executor implementation closes stdin or stops draining
      at `result`, refactor the Claude executor to keep stdin
      open across turns and expose its event iterator as
      long-lived (one async iterator per node dispatch, yields
      `result` events as turn boundaries without terminating).
      [Refactored the Claude executor to keep stdin open until
      the runner calls `closeInput()`; the iterator stays live
      across turns. Live-CLI manual verification is a runtime
      step the operator performs against the bundled claude
      binary; the controllable `NudgeableExecutor` test in
      `src/runner/run.test.ts` exercises the same flow
      in-process.]
- [x] 3.3 Add a `writeUserMessage(msg: string): Promise<void>`
      method on the Claude executor that frames `msg` as a
      stream-json user-message event and writes it to the
      executor's stdin. The method SHALL reject the returned
      promise on stdin write failure (EPIPE, EBADF, OS error)
      so the runner can handle the broken-pipe case
      explicitly.
- [x] 3.4 Add a `nudges_used: number` field to `NodeResult`
      (default `0`). Plumb it through the executor → runner
      → store path; the value is set by the runner (not the
      executor) since the runner owns the nudge decision.
- [x] 3.5 Extend the executor's event-kind taxonomy to
      include `runner-action` and `runner-nudge` (the runner
      is the source of these events, but they ride the
      executor's event stream so downstream consumers see one
      ordered timeline).

## 4. Runner — post-execution nudge loop

- [x] 4.1 Refactor the post-execution flow in
      `src/runner/run.ts` to the loop shape described in
      `design.md`. Pseudocode anchor: dispatch → loop {
      drain to next `result`, parse sentinel, short-circuit
      on sentinel-failed, validate outputs, on missing AND
      budget > 0 AND `supportsNudge` emit events, write
      stdin, decrement budget, continue; else break } →
      record NodeResult.
- [x] 4.2 Compute the per-dispatch nudge budget from
      `node.output_nudge_budget` (default `1` after schema
      validation). Track remaining budget and total nudges
      used in runner-local state for the duration of the
      dispatch.
- [x] 4.3 On missing-outputs detection, build the
      `MissingOutput[]` list from the outputs-validator's
      result (the validator already knows key, type,
      expected path, and detail string — surface them
      together so the helper has everything it needs).
- [x] 4.4 Emit the `system / runner-action` and
      `user / runner-nudge` events on the runner's `onEvent`
      consumer **before** writing to stdin (so a stdin
      failure does not leave an unaccompanied tool-call event
      hanging). Both events SHALL carry `nodeId` and
      `iteration`.
- [x] 4.5 Call `executor.writeUserMessage(nudgeMessage)`. On
      success, increment `nudges_used`, decrement budget,
      continue the loop. On rejection, break out of the loop
      with a synthetic `failed` result whose metadata records
      `missing_required_output` plus a `nudge stdin write
      failed: <error>` detail suffix.
- [x] 4.6 When the loop exits because budget is exhausted
      (NOT because of a stdin error), record `failed` with
      reason `missing_required_output` and the standard
      `missing_outputs` / `missing_outputs_detail` metadata
      from the validator's last pass — same shape as the
      pre-nudge `node-outputs` failure mode. The
      `nudges_used` counter reflects how many nudges the
      runner spent.
- [x] 4.7 When `supportsNudge: false`, skip the nudge loop
      entirely: missing outputs go straight to the existing
      override path. The schema-accepted
      `output_nudge_budget` has no runtime effect on those
      executors.
- [x] 4.8 Tests in `src/runner/run.test.ts` covering every
      scenario in the graph-runner delta's "Post-execution
      nudge loop" requirement.

## 5. Storage — `nudges_used` persistence and events

- [x] 5.1 Verify the existing `NodeResult` JSON serialization
      in `src/storage/sqlite.ts`'s `recordNodeEnd` (or
      equivalent) round-trips the new `nudges_used` field
      without a schema migration. Add a test asserting a
      written-then-read `NodeResult` preserves the field.
- [x] 5.2 Verify the existing event-store hook persists
      `runner-action` and `runner-nudge` events the same way
      it persists model events. Add a test asserting a
      run's event stream replays the nudge sequence in
      order.

## 6. Documentation

- [x] 6.1 Append a "Nudge recovery" section to
      `docs/concepts/Outputs.md` covering: when the loop
      fires, the canonical nudge message, the
      `output_nudge_budget` schema, the broken-stdin failure
      path, and a one-line note on `nudges_used`.
- [x] 6.2 Extend the Schema section of
      `docs/concepts/Factory.md`'s node-level table with an
      `output_nudge_budget` row matching the existing depth
      used for `outputs:`.
- [x] 6.3 Cross-link the new sections to
      `docs/decisions/0028-Node-Outputs-Nudge.md` and to
      `[[0027-Node-Outputs]]` for context.

## 7. Examples — optional follow-on

- [x] 7.1 No example factory change is required for v1
      acceptance. (`examples/sdd.yaml` already gains an
      `outputs:` block in the MCP follow-on; adding
      `output_nudge_budget` there is cheap once it lands —
      but is out of scope for this change.)
