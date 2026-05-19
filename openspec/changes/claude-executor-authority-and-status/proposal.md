## Why

The first real dogfood of the SDD factory (running it on a copy of itself
against a minifac worktree) surfaced two bugs in the `claude` executor:

1. **No permission flags.** In `--print` mode the Claude CLI defaults to a
   strict deny policy. `Write`, `Edit`, and `Bash` with side effects are
   rejected because there's no human to approve. The spawned session has
   no way to do real work — it diagnoses the situation in prose and exits
   cleanly. Factory nodes that need to write files or run external commands
   (e.g. `openspec`) cannot.

2. **Status is exit-code-only.** A Claude session that *correctly diagnosed*
   it accomplished nothing — and said so explicitly ("Exiting non-zero") —
   still left the CLI exiting `0` (`is_error: false`, `subtype: "success"`,
   `stop_reason: "end_turn"`). The runner marked the node `succeeded` and
   proceeded. There is no in-band way for the model to signal work failure.

Both bugs land in the same dogfood scenario and don't help shipped
separately (permissions without status signaling lets nodes silently
succeed; status signaling without permissions doesn't help nodes that
can't do work in the first place).

## What Changes

- Extend the `claude` executor's `with:` schema with three optional fields
  that opt the node into broader authority:
  - `permission_mode` — one of `"default"`, `"accept_edits"`,
    `"bypass_permissions"`; maps to the CLI's `--permission-mode`.
  - `allowed_tools` — array of tool patterns; maps to `--allowedTools`.
  - `add_dirs` — array of additional directories; maps to repeated
    `--add-dir <dir>`.
  Defaults omit every flag — current `hello.yaml` behavior is unchanged.
- Validate the new fields: reject unknown `permission_mode` values, reject
  empty strings in `allowed_tools` / `add_dirs`. Validation failures yield
  `failed` status with `invalid_with` meta, same as today.
- Add a sentinel-string status signaling path. The executor scans the
  final stream-json `result` event's `result` field for a marker line
  matching `^MINIFAC_STATUS:\s*(succeeded|failed)\s*$`. If `failed` is
  found, the executor yields a `failed` terminal status with the captured
  reason — *even when the CLI exited 0*. If no sentinel is present, the
  executor falls back to the existing exit-code semantics (so `hello.yaml`
  keeps working without prompt changes).
- Update the wire-format comment block at the top of
  `src/executor/claude.ts` to describe the sentinel contract and the
  authority flags so prompt authors know what to write.
- Snapshot-test the wire format for representative `with:` payloads so
  any drift is deliberate.

Explicitly **out of scope** (deferred to later changes):

- A native `shell` executor (its own future change).
- An interactive `permission_mode: "ask"` flow — no human is in the loop
  yet; revisit with the daemon.
- Updating the SDD factory's prompts to use the sentinel + opt into the
  right permission mode. That's the *next* change after this one; this
  change just makes the surface available.
- Auth model for the eventual daemon / web viewer (`serve-and-viewer`).
- Persistent storage adapters (`beads-dolt-storage`).

## Capabilities

### New Capabilities

<!-- None — both pieces of behavior live in the existing node-executor capability. -->

### Modified Capabilities

- `node-executor`: the canonical executor capability gains two new
  requirements scoped to the `claude` executor — per-node authority
  controls and sentinel-based status signaling — and tightens the
  existing "Claude executor uses stream-json..." requirement to describe
  the new status precedence (sentinel beats exit code; exit code is the
  fallback). The executor *interface* (signatures, event shape) does
  not change; future executors are not forced to implement these knobs.

## Impact

- One file changes in `src/`: `src/executor/claude.ts`. No new files, no
  new modules, no new runtime dependencies.
- The factory schema (`factory-schema` capability) does not change —
  `with:` remains an opaque per-executor object.
- The `NodeExecutor` interface and `NodeEvent` shape do not change.
- `examples/hello.yaml` is unchanged. Existing factories that don't set
  the new `with:` fields behave exactly as today.
- A small prompt-authoring contract is added: prompts that want to fail
  the node from inside the model must end with a `MINIFAC_STATUS:` line.
  This is documented in the wire-format comment block; prompts that
  don't use it keep relying on exit codes.
- Future change: the SDD factory's prompts and node definitions will be
  updated to opt into the new authority knobs and use the sentinel. That
  work lands in a separate proposal.
