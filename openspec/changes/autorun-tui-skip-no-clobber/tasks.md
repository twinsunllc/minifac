# Tasks

## 1. Reducer fix

- [x] 1.1 In `src/tui/autorun-reducer.ts`, replace the
      `skipped` case in `applyAutorunEvent` so the row is
      preserved when its current status is `running`,
      `succeeded`, or `failed`. Only rows whose current status
      is `queued` or `skipped` SHALL be overwritten with the
      new `skipped` status + `skipReason`. Concretely:

      ```ts
      case "skipped":
        return upsertBrief(state, event.change, (row) => {
          if (
            row.status === "running" ||
            row.status === "succeeded" ||
            row.status === "failed"
          ) {
            return row;
          }
          return { ...row, status: "skipped", skipReason: event.reason };
        });
      ```

- [x] 1.2 Leave the `dry-run-decision` handler's `skip` path
      untouched — its semantics are intentionally distinct.

## 2. Reducer tests

- [x] 2.1 In the existing reducer test file (alongside
      `src/tui/autorun-reducer.ts`), add a test asserting that
      `started → skipped(in-flight)` leaves the row with
      `status === "running"` and `skipReason === undefined`.

- [x] 2.2 Add a test asserting that
      `started → completed(succeeded) → skipped(activity-
      succeeded)` leaves the row with `status === "succeeded"`
      and `skipReason === undefined`.

- [x] 2.3 Add a mirror test asserting that
      `started → completed(failed) → skipped(activity-failed)`
      leaves the row with `status === "failed"` and
      `skipReason === undefined`.

- [x] 2.4 Confirm the existing `skipped → started → completed`
      tests (forward-clearing path) still pass unchanged.

- [x] 2.5 Add a sanity test asserting the unchanged behavior
      for the `queued → skipped` and `skipped → skipped(new
      reason)` paths (no regression to the existing overwrite
      semantics when the row's status is `queued` or
      `skipped`).

## 3. Validation

- [x] 3.1 Run `openspec validate autorun-tui-skip-no-clobber
      --strict` and ensure it exits 0.
- [x] 3.2 Run `npm test` and ensure all tests pass (including
      the existing `skipped → started → completed` path).
- [x] 3.3 Run `npm run build` and ensure it exits clean.
