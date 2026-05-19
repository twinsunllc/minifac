## Why

The shipped SDD factory (`examples/sdd.yaml`) was authored before the
`claude` executor learned about authority controls and sentinel status
signaling. The first real dogfood run produced four `succeeded` events
with zero actual work done: the spawned sessions could not `Write`,
`Edit`, or run side-effecting `Bash` under the strict-deny default
policy, and even when each session correctly diagnosed it had
accomplished nothing, the CLI still exited 0 and the runner marked the
node `succeeded`. The just-archived `claude-executor-authority-and-status`
change shipped the surface (`permission_mode`, `allowed_tools`,
`add_dirs`, and the `MINIFAC_STATUS` sentinel). This change makes the
SDD factory actually use it, and updates the canonical `sdd-factory`
spec to mandate both so the factory can't silently regress to the broken
shape.

## What Changes

- Each of the four shipped SDD nodes (`propose`, `apply`, `verify`,
  `archive`) gains `permission_mode: "bypass_permissions"` in its
  `with:` block. The factory grants the spawned session full authority
  inside the user-chosen `cwd`; the user is responsible for `cwd`
  correctness.
- Each node's prompt is rewritten to drop the "exit 0 / exit non-zero"
  success/failure language and to instruct the model to end its final
  assistant text with the `MINIFAC_STATUS:` sentinel (with a `REASON:`
  line on failure).
- `examples/sdd.md` gains three documentation updates: the
  `permission_mode` field is added to the "Fields users edit when
  copying" section (as an optional knob for braver copies); a new
  "Status signaling" section documents the sentinel contract with a
  copy-paste block; a new "Security posture" section documents the
  user-trust-cwd framing. A short migration paragraph addresses users
  who copied `sdd.yaml` before this change.
- `src/factory/sdd-example.test.ts` is extended to assert each node
  declares `permission_mode: "bypass_permissions"` and each prompt
  contains the literal substring `MINIFAC_STATUS`.
- The `sdd-factory` canonical spec is updated:
  - The "SDD factory per-node responsibility" requirement is **MODIFIED**
    so the success/failure signal mechanism is the `MINIFAC_STATUS`
    sentinel (with the exit-code path retained as a documented
    fallback that the factory does not rely on). Existing scenarios
    that named exit codes are updated; new scenarios cover the
    sentinel.
  - A new requirement is **ADDED** mandating that every SDD node sets
    `permission_mode: "bypass_permissions"` in `with:`. The
    requirement text documents the user-trust-cwd security posture and
    explicitly forbids shipping the factory with the field omitted on
    any node.
  - A new requirement is **ADDED** mandating that each node's prompt
    instruct the model to emit the `MINIFAC_STATUS` sentinel as its
    final line, with a `REASON:` line on failure.

Explicitly **out of scope** (deferred to future proposals):

- A native `shell` executor (a `node-executor` change of its own).
- Daemon and web viewer (`serve-and-viewer`).
- Per-node `allowed_tools` allowlists or `add_dirs`. With
  `bypass_permissions`, neither is needed; speculatively pinning a
  tool allowlist that has to be updated every time the OpenSpec CLI
  grows a flag is not worth the maintenance tax.
- Factory-level `cwd:` default or templating (`--var change=<name>`).
- Tightening the security posture to `accept_edits`. See `design.md`.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `sdd-factory`: the canonical SDD capability is updated so it
  mandates the authority + sentinel posture that the shipped factory
  actually needs to function. One existing requirement is rewritten
  (per-node responsibility, swapping exit-code semantics for sentinel
  semantics) and two are added (authority controls; sentinel-emission
  prompt contract).

## Impact

- `examples/sdd.yaml` and `examples/sdd.md` are the only repo-shipped
  factory artifacts that change. No `src/` changes beyond the
  structural test.
- The `node-executor` canonical spec is **not** touched. The new
  authority and sentinel features are opt-in and backwards-compatible
  by design; this change merely opts in.
- The factory-schema does not change. `with:` remains the opaque
  per-executor object it has been since v0.
- Users who copied `examples/sdd.yaml` before this change will continue
  to run on the old broken contract. We cannot help them retroactively;
  the migration paragraph in `examples/sdd.md` tells them how to fix
  their copies.
- No new runtime dependencies. No `package.json` changes.
