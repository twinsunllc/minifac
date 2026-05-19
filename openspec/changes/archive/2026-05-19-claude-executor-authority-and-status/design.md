## Context

The `claude` executor (`src/executor/claude.ts`) spawns the Claude CLI in
non-interactive streaming mode:

```
claude --print --verbose \
       --input-format stream-json \
       --output-format stream-json \
       [--model <model>] [...with.args]
```

The first dogfood — running the SDD factory on a copy of itself, targeting
a worktree of minifac, attempting to propose+apply the next change
(`serve-and-viewer`) — surfaced two related bugs:

1. **Permissions.** No flags are passed to permit filesystem writes or
   external commands. In `--print` mode the CLI defaults to a strict
   allow-list and rejects `Write`, `Edit`, `Bash`-with-redirection, and
   unknown executables (including `openspec`). The apply node's Claude
   diagnosed this exactly:

   > "No flags are passed to permit filesystem writes or run external
   > commands. In non-interactive (`--print`) mode the CLI defaults to a
   > strict allow-list and rejects `Write`, `Edit`, `Bash`-with-redirection,
   > and unknown executables (including `openspec`). The spawned session
   > has no way to ask the human running `minifac run`, so every
   > permission prompt becomes an immediate denial."

   The session has no way to ask, so every prompt becomes a denial.

2. **Status.** The runner's terminal status is derived purely from the
   child exit code (`code === 0` → `succeeded`, else `failed`,
   `src/executor/claude.ts` around line 217). In the dogfood run the
   model *correctly* recognized nothing got done and wrote
   "Exiting non-zero" in its final message — but the CLI still exited 0
   (`is_error: false`, `subtype: "success"`, `stop_reason: "end_turn"`).
   The runner marked the node `succeeded`. There is no in-band way for
   the model to signal work-level failure.

The `with:` envelope is per the `factory-schema` capability an opaque
object validated by each executor. That's the right seam to expose
per-node authority knobs without touching the core schema or the
`NodeExecutor` interface.

Constraints from `CLAUDE.md`:

- No premature subsystems; this is one file's worth of change.
- No anthropomorphic metaphors. Things stay named after what they do.
- No new runtime dependencies. Use Zod (already a dep) for validation.
- Snake_case YAML.
- Default behavior must not change for `hello.yaml`.

## Goals / Non-Goals

**Goals:**

- A factory node can opt into broader CLI authority via three optional
  `with:` fields, each mapping to a documented Claude CLI flag.
- A spawned Claude session can signal `failed` to the runner from inside
  the model's final response, even when the CLI exits 0.
- Both behaviors are opt-in. Existing factories with no new fields and
  no sentinel string behave identically to today (`hello.yaml` unchanged).
- The wire-format comment block at the top of `src/executor/claude.ts`
  documents both contracts, so prompt authors know what to write.
- Snapshot tests cover representative `with:` payloads so any drift in
  the generated CLI args is deliberate.

**Non-Goals:**

- No native `shell` executor. That's a separate change.
- No interactive `permission_mode: "ask"` flow. There's no human in the
  loop yet; revisit with the daemon.
- No change to the `NodeExecutor` interface or `NodeEvent` shape. Other
  future executors (codex, opencode) are not forced to implement
  permission knobs or sentinels.
- No update to the SDD factory's prompts. That's the next change.
- No `disallowed_tools` knob. Skip until there's a real use case.

## Decisions

### Decision: Ship three authority knobs — `permission_mode`, `allowed_tools`, `add_dirs`

These are the minimum set that unblocks the dogfood scenario:

- `permission_mode: "default" | "accept_edits" | "bypass_permissions"` —
  maps to `--permission-mode <mode>`. `accept_edits` is the sweet spot
  for SDD-style nodes (Write/Edit auto-allowed; Bash still gated).
  `bypass_permissions` is escape-hatch for the "just let the model
  drive" cases.
- `allowed_tools: string[]` — maps to `--allowedTools <comma-list>`.
  Tool patterns like `"Bash(openspec:*)"` let a node grant just the
  external commands it needs.
- `add_dirs: string[]` — maps to repeated `--add-dir <dir>`. The SDD
  factory needs this to operate on a target worktree outside the
  factory's own cwd.

Validation rules:

- `permission_mode` must be one of the three literal strings; reject
  unknown values with `invalid_with` meta.
- `allowed_tools` and `add_dirs` must be arrays of non-empty strings.
- Strict-mode Zod object — unknown keys in `with:` are rejected as
  today.

**Why these three and not more?** `disallowed_tools` and friends are
easy to add later when there's a real use case. `permission_mode`
covers the broad-strokes posture; `allowed_tools` covers fine-grain
positive grants; `add_dirs` is the cwd-scope escape valve. Together they
cover every variant the dogfood scenario needs without bloating the
surface.

**Alternatives considered:** (a) Ship only `permission_mode`. Too coarse
— the SDD factory wants to allow `openspec` Bash but not arbitrary
shell. (b) Ship a single opaque `cli_flags: string[]` passthrough. Too
loose; we'd have no validation, and the wire format would be
indistinguishable from `with.args` (which already exists). (c) Bake a
named preset like `mode: "sdd-author"`. Premature — we have one factory
to base presets on.

### Decision: Default = no flags. Backwards-compatible at the `with:` level

If a node doesn't set the new fields, the executor emits no new CLI
flags. `hello.yaml` continues to spawn `claude --print --verbose
--input-format stream-json --output-format stream-json` with no
authority knobs.

**Why:** the safest default is the current one. Nodes opt into authority
explicitly; nodes that don't need it don't get it. Mirrors how `model`
and `args` work today.

### Decision: Status signaling via sentinel string in the final assistant text

The executor scans the *final* stream-json `result` event's `result`
field for a marker line matching the regex:

```
/^MINIFAC_STATUS:\s*(succeeded|failed)\b\s*(?:\nREASON:\s*(.*))?/m
```

Behavior:

- If the marker matches `failed`, the executor yields a `failed` terminal
  status with `meta: { reason: "sentinel_failed", sentinel: <captured reason>, exitCode: <code> }`,
  *regardless of the CLI's exit code* (including 0).
- If the marker matches `succeeded`, the executor yields a `succeeded`
  terminal status (in practice no-op since exit 0 would also produce that;
  having it on both sides keeps the wire contract symmetric and lets
  prompts always end with one of the two markers).
- If no marker is present, the executor falls back to exit-code
  semantics: `0` → `succeeded`, non-zero → `failed`. This is the same
  behavior as today, so `hello.yaml` and any prompt unaware of the
  sentinel keep working.
- The marker must appear in the *final assistant message* (the
  stream-json `result` event's `result` field, which the CLI populates
  with the model's last assistant turn). Sentinels appearing earlier in
  the conversation are ignored — they were a draft, not the verdict.

**Why sentinel string over sentinel file:** Sentinel string is the lightest
contract. No filesystem write, no race with concurrent runs, nothing the
prompt has to be told about beyond "end your response with this line."
The executor already parses stream-json line-by-line, so capturing the
last `result` event is a small additional concern.

**Why not stream-json native fields:** The CLI's `result` event has
`is_error`, `subtype`, `stop_reason`. In the dogfood case all three
reported success — they reflect session health, not work outcome. They
can't distinguish "model worked and won" from "model worked, looked, and
declared the task impossible." Only the model's own words can.

**Why not exit-code only:** Bug #2 *is* the exit-code-only failure mode.
A model running in `--print` mode has no good way to make the CLI exit
non-zero without crashing. The model can decide to fail; only the
sentinel lets it tell us.

**Alternatives considered:**

- **Sentinel file (`.minifac/last-status.json`).** Robust against
  Claude reformatting the marker line, but it adds a file-system
  contract: the executor has to know the path, the prompt has to know
  to write JSON, the cwd has to be writable, and we now have a per-run
  scrub concern. Heavier for no clear win in v0.
- **Reformulating the prompt so the model exits non-zero via a tool
  call.** Requires a Bash invocation just to set an exit code, which
  re-introduces a permissions dependency loop. Not worth it.
- **Sentinel as a structured JSON line.** Considered, but a single
  flat regex on a known marker is easier to author and review, and
  fits the "model writes prose" reality of `result.result`.

### Decision: Sentinel instructions are *not* auto-appended to the prompt

The executor parses the sentinel but does not inject instructions for it
into the prompt. Two reasons:

1. The prompt is the user-authored contract with the model; the executor
   silently mutating it is surprising and would break the snapshot test
   for `buildStreamJsonInput`.
2. Prompts that don't use the sentinel must keep working (exit-code
   fallback). Auto-injecting instructions would force every prompt to
   end with the marker, defeating the fallback.

The wire-format comment block at the top of `claude.ts` documents the
contract so prompt authors (and the next change's SDD factory update)
know exactly what to write.

### Decision: Wire-format snapshot covers both default and authority-enabled `with:`

The current snapshot covers the stdin envelope. The new snapshot must
also cover the constructed `cliArgs` array for representative `with:`
payloads:

- Defaults only (`{ prompt: "hi" }`) — must equal today's args.
- All three authority knobs set — must produce
  `--permission-mode accept_edits --allowedTools "Bash(openspec:*),Write" --add-dir /tmp/x --add-dir /tmp/y`
  in a deterministic order.

**Why:** wire-format drift is the single most likely regression. Lock it
in.

### Decision: `allowed_tools` joins on `,`; `add_dirs` repeats the flag

Claude CLI accepts `--allowedTools "Tool1,Tool2"` as a comma-separated
list and `--add-dir <dir>` as a repeatable flag. We use both shapes as
they are. Validation rejects empty strings so we never emit
`--add-dir ""`. If the CLI shape changes (e.g. moves to repeated
`--allowed-tool` flags), it's a one-line change confined to `claude.ts`,
and the snapshot test will catch it.

### Decision: Failure precedence — sentinel beats exit code

When both are present (e.g. CLI exits non-zero *and* the model wrote
`MINIFAC_STATUS: succeeded`), the sentinel wins. Rationale: the model
saw the result and pronounced; the CLI exit code is often just
"the session ended cleanly." If we want to revisit, the symmetric case
(exit 0 + `MINIFAC_STATUS: failed`) is the one we actually care about —
and there the sentinel correctly fails the node.

For observability, `meta` always carries the raw exit code alongside
the sentinel reason so debugging is unambiguous.

## Risks / Trade-offs

- **[Sentinel fragility — model reformats the marker line]** → Mitigation:
  document the exact regex in the wire-format comment block and in the
  spec. The prompt for any node opting in should include explicit
  instructions ("end your response with a line that exactly matches
  `MINIFAC_STATUS: succeeded` or `MINIFAC_STATUS: failed`"). If models
  ignore the instruction in practice, switch to sentinel-file in a
  follow-up change without breaking the executor interface.
- **[`bypass_permissions` is a big foot-gun]** → Mitigation: documenting
  it in the spec as the escape-hatch posture and naming the field
  literally `bypass_permissions` makes the cost legible at the
  factory-author level. There's no runtime guard; this is the same
  posture the CLI itself takes.
- **[CLI flag drift — `--allowedTools` vs `--allowed-tools`]** →
  Mitigation: confine flag knowledge to `claude.ts`, snapshot-test the
  emitted `cliArgs`, and treat any drift as a deliberate change to that
  one file. Same posture as the existing wire-format snapshot.
- **[Two ways to spell authority — `with.args` raw passthrough vs. the
  new typed fields]** → Mitigation: the new fields are explicitly
  documented as the preferred surface; `with.args` remains for
  one-offs (e.g. `--debug`) but is *appended after* the typed flags so
  the typed fields aren't accidentally overridden. We don't deprecate
  `args` — it's a useful escape valve — but the spec scenarios
  exercise the typed path.
- **[Sentinel hides genuine CLI exit failures]** → Mitigation: sentinel
  beats exit code only when the sentinel matches. A CLI crash that
  produces no `result` event (no final assistant text) leaves the
  sentinel absent → falls back to exit-code → reports `failed`.

## Migration Plan

No data migration. No deployed users. The change is opt-in at the
factory level: a node that doesn't set the new `with:` fields and
doesn't emit the sentinel behaves exactly as before. `examples/hello.yaml`
is not edited as part of this change.

The next change (a `sdd-factory` follow-up — not in this proposal) will
update the SDD factory's prompts and nodes to use the new fields and
sentinel.

## Open Questions

- **Sentinel adoption in the SDD factory.** The next change must decide
  whether to (a) tack instructions onto every node prompt or
  (b) consolidate them into a shared preamble. Out of scope here.
- **CLI flag name confirmation.** `--allowedTools` vs `--allowed-tools`
  is plausibly either spelling depending on CLI version; the apply
  phase must confirm against the installed `claude --help` output and
  encode the correct spelling. The snapshot test pins it.
- **Should `with.args` also be vetted?** Today `with.args` is an
  arbitrary string passthrough. The new typed fields don't change that.
  If users use `args` to set `--permission-mode` directly, we don't
  detect the conflict. Defer; this isn't observed.
- **A `shell` executor.** Eventually some nodes will be just "run this
  command" — Claude is overkill. That's its own future change.
- **Daemon / web viewer auth model.** Separate change
  (`serve-and-viewer`).
- **Persistent run history.** Separate change (`beads-dolt-storage`).
