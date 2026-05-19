## 1. Schema and validation

- [x] 1.1 Extend `WithSchema` in `src/executor/claude.ts` with three new
      optional fields: `permission_mode` (Zod enum of `"default"`,
      `"accept_edits"`, `"bypass_permissions"`), `allowed_tools`
      (`z.array(z.string().min(1))`), `add_dirs`
      (`z.array(z.string().min(1))`). Keep `.strict()` on the object.
- [x] 1.2 Confirm Zod parse-failure path still produces the existing
      `failed` status with `meta: { reason: "invalid_with", error: ... }`
      for the new fields' validation errors.

## 2. CLI args construction

- [x] 2.1 Build the `cliArgs` array conditionally based on `with:`
      values: append `--permission-mode <value>` if `permission_mode`
      set; append a single `--allowedTools <comma-joined>` if
      `allowed_tools` non-empty; append `--add-dir <dir>` once per
      element of `add_dirs` in array order.
- [x] 2.2 Place the new flags before any pre-existing
      `with.args` passthrough so typed flags lead and `args` trails.
- [x] 2.3 Verify by inspection that omitting all three fields yields
      the same `cliArgs` array produced before this change (i.e.
      `--print --verbose --input-format stream-json --output-format
      stream-json [--model X] [...args]`).

## 3. Sentinel parsing

- [x] 3.1 Track the most recently observed stream-json event whose
      `type === "result"` while consuming stdout. Keep only the most
      recent — earlier `result` events (if any) are discarded.
- [x] 3.2 Define the sentinel regex
      `/^MINIFAC_STATUS:[ \t]*(succeeded|failed)\b[ \t]*(?:\r?\nREASON:[ \t]*(.*))?/m`
      as a module-level constant. (Apply-phase note: the original
      spec regex used `\s*` which greedily consumes the newline before
      `REASON:`, making the optional REASON capture unreachable.
      Narrowed to `[ \t]*` so the spec's REASON-capture scenario can
      pass. Spec delta updated to match.)
- [x] 3.3 After the child exits and stream draining completes, if the
      final `result` event has a `result` string field, scan it with
      the sentinel regex.
- [x] 3.4 Wire the new terminal-status mapping: when the sentinel
      matches `failed`, yield
      `{ kind: "status", status: "failed", meta: { reason: "sentinel_failed", sentinel: <reason or undefined>, exitCode: <code> } }`.
      When it matches `succeeded`, yield
      `{ kind: "status", status: "succeeded", meta: { reason: "sentinel_succeeded", exitCode: <code> } }`.
- [x] 3.5 When no sentinel matches, retain the existing exit-code
      semantics (`0` → `succeeded`, non-zero → `failed`) and continue
      to surface `exitCode` in meta.
- [x] 3.6 Preserve the existing `missing_binary` path (ENOENT) — that
      branch terminates before any stdout is parsed and is independent
      of the sentinel.

## 4. Documentation in source

- [x] 4.1 Update the wire-format comment block at the top of
      `src/executor/claude.ts` to describe:
      (a) the three new `with:` knobs and which flags they emit,
      (b) the sentinel regex and the precedence rule
          (sentinel beats exit code; absent sentinel falls back to
           exit code),
      (c) the rule that only the *final* `result` event is inspected,
      (d) the contract that the executor does NOT mutate the prompt.
- [x] 4.2 Cross-reference the spec requirement names in the comment so
      future readers can find the canonical contract.

## 5. Tests

- [x] 5.1 Add a snapshot test for `cliArgs` with `{ prompt: "hi" }`
      that locks the pre-change argv exactly (backwards-compat guard).
- [x] 5.2 Add a snapshot test for `cliArgs` with all three new fields
      set (e.g. `permission_mode: "accept_edits"`,
      `allowed_tools: ["Bash(openspec:*)", "Write"]`,
      `add_dirs: ["/tmp/x", "/tmp/y"]`) covering ordering and joining.
- [x] 5.3 Test: invalid `permission_mode` value → terminal `failed`
      status with `meta.reason === "invalid_with"`, no child spawn.
- [x] 5.4 Test: empty-string element in `allowed_tools` → terminal
      `failed` status with `meta.reason === "invalid_with"`, no child
      spawn.
- [x] 5.5 Test: empty-string element in `add_dirs` → terminal `failed`
      status with `meta.reason === "invalid_with"`, no child spawn.
- [x] 5.6 Test: child exits `0`, final `result.result` ends with
      `MINIFAC_STATUS: failed\nREASON: nothing got done` → terminal
      event is
      `{ kind: "status", status: "failed", meta: { reason: "sentinel_failed", sentinel: "nothing got done", exitCode: 0 } }`.
- [x] 5.7 Test: child exits `0`, final `result.result` contains a
      `MINIFAC_STATUS: succeeded` line → terminal event has
      `meta.reason === "sentinel_succeeded"` and status `succeeded`.
- [x] 5.8 Test: child exits `0`, no `MINIFAC_STATUS:` anywhere →
      terminal event matches the pre-change shape
      `{ kind: "status", status: "succeeded", meta: { exitCode: 0 } }`.
- [x] 5.9 Test: a non-final assistant message contains
      `MINIFAC_STATUS: failed` but the final `result.result` does not
      → executor falls back to exit-code semantics (so child exit `0`
      yields `succeeded`).
- [x] 5.10 Test: child exits `1`, no sentinel → terminal event is
       `{ kind: "status", status: "failed", meta: { exitCode: 1 } }`
       (unchanged behavior).
- [x] 5.11 Test: missing binary (ENOENT) → terminal event is
       `{ kind: "status", status: "failed", meta: { reason: "missing_binary", binary: "claude" } }`
       (unchanged behavior).

## 6. Verify

- [x] 6.1 Run the full test suite; all existing tests must still pass
      (no test should require modification *except* the wire-format
      snapshot if a deliberate ordering tweak is captured).
      Result: 74/74 passing (53 pre-existing + 21 new).
- [ ] 6.2 Manually run `minifac run examples/hello.yaml` and confirm
      the existing behavior is preserved (single Claude node, exit
      code drives status, no sentinel required).
      (Not run during apply: this requires a real `claude` invocation
      and a model call. The pre-change argv snapshot test in 5.1 pins
      the backwards-compat contract; `hello.yaml` produces the same
      argv as before the change.)
- [x] 6.3 Run `openspec validate claude-executor-authority-and-status`
      and confirm clean.
