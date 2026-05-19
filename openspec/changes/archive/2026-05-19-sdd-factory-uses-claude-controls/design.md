## Context

The shipped SDD factory at `examples/sdd.yaml` was written before the
`claude` executor learned about authority controls and sentinel
status. As a result, when run today it produces four `succeeded` events
with zero actual work done:

- Under the strict-deny default permission policy of `claude --print`,
  the spawned session cannot `Write`, `Edit`, or run side-effecting
  `Bash`. `propose` cannot scaffold OpenSpec changes, `apply` cannot
  edit files, `verify` cannot run `npm test`, and `archive` cannot run
  `openspec archive`.
- Even when a session correctly diagnosed it had done nothing, the CLI
  still exited 0. The runner derived `succeeded` from the exit code and
  scheduled the next node, so the entire run reported success despite
  having accomplished nothing.

The just-archived `claude-executor-authority-and-status` change shipped
two opt-in mechanisms that fix both bugs:

1. Per-node authority knobs in `with:` — `permission_mode`,
   `allowed_tools`, `add_dirs` — each mapping to a documented Claude
   CLI flag and validated by the executor.
2. A `MINIFAC_STATUS` sentinel parsed out of the final stream-json
   `result` event. When the sentinel reports `failed`, the executor
   yields `failed` regardless of the exit code; when it reports
   `succeeded`, the executor yields `succeeded`. With no sentinel,
   exit-code semantics are preserved unchanged.

The features are opt-in. The SDD factory needs to opt in.

Constraints from `CLAUDE.md`:

- Snake_case YAML keys.
- No anthropomorphic metaphors.
- No new runtime dependencies.
- The `node-executor` canonical spec is load-bearing; do not change it.

## Goals / Non-Goals

**Goals:**

- The shipped `examples/sdd.yaml` actually does its job: each node can
  perform the file edits and Bash invocations its responsibility
  demands.
- Status reported by each node reflects what the model actually
  accomplished, not whether the CLI process exited cleanly.
- The `sdd-factory` canonical spec mandates both behaviors so future
  edits can't silently regress the factory back to the broken shape.
- Documentation teaches the contract (sentinel format, security
  posture) so users who copy the file know what they are signing up
  for.

**Non-Goals:**

- Modifying `src/` beyond extending the existing structural test.
- Modifying the `node-executor` canonical spec. The features used here
  are opt-in and backwards-compatible by design.
- Adding `allowed_tools` allowlists or `add_dirs` to the shipped
  factory. `bypass_permissions` is sufficient on its own.
- Adding a native `shell` executor.
- Building factory-level `cwd:` defaults or templating.
- Tightening the security posture to `accept_edits`. See the decision
  below.

## Decisions

### Decision: Each SDD node sets `permission_mode: "bypass_permissions"`

Both `accept_edits` and `bypass_permissions` are plausible postures
for these nodes. We pick `bypass_permissions`.

- `bypass_permissions` grants the spawned session full authority
  inside `cwd`. Every `Write`/`Edit`/`Bash` invocation is allowed
  without prompting. This matches what each SDD node needs:
  - `propose` runs `openspec new change`, writes `proposal.md`,
    `design.md`, spec deltas, and `tasks.md`, and drives
    `openspec validate` to clean.
  - `apply` reads `tasks.md`, performs the unchecked tasks
    (potentially editing arbitrary files in the target repo), and
    commits.
  - `verify` runs `npm test`, `npm run build`, `npm run check`, and
    `openspec validate`.
  - `archive` runs `openspec archive`.
- `accept_edits` auto-approves `Write` and `Edit` but still gates
  side-effecting `Bash`. To make it work on these nodes we would
  have to:
  - Maintain an `allowed_tools` allowlist covering at minimum
    `Bash(openspec:*)`, `Bash(npm:*)`, `Bash(git:*)`, and probably
    `Bash(node:*)` and a handful of others.
  - Update that allowlist every time a verify command grows a new
    sub-tool, every time the OpenSpec CLI adds a flag whose
    invocation shape we did not pre-allow, every time `apply` needs
    to run a tool we did not foresee.
  - Document the allowlist in the spec or risk silent drift.

The tradeoff: `bypass_permissions` widens the blast radius if the
spawned session is malicious or buggy. The mitigations are:

- The user explicitly chose the `cwd`. They are responsible for
  pointing the factory at a directory where they accept full-authority
  edits. We document this as the "user-trust-cwd" framing in the
  spec text and in `examples/sdd.md`.
- The prompts ship in this repo and are read by the user before they
  invoke `minifac run`. There is no remote prompt injection vector
  in the shipped factory.
- The field is literally named `bypass_permissions`. Anyone copying
  the factory and reading the YAML sees the posture.

We accept the tradeoff. `accept_edits` is rejected for v0 because the
`allowed_tools` matrix is not worth the maintenance tax for a
template the user is expected to copy and read.

**Alternatives considered:** (a) `permission_mode: "accept_edits"`
with a hand-curated `allowed_tools` list — rejected as above. (b) Mix
modes per node (e.g. `bypass_permissions` on `apply`,
`accept_edits` on `verify`) — rejected as needless complexity; if any
node needs full authority, the security posture is already
"full-authority on this cwd," and splitting it across nodes does not
change that posture. (c) Defer the proposal until we have a
fine-grained policy story — rejected because the factory is broken
today and the user wants to dogfood it.

### Decision: Do not ship `add_dirs` or `allowed_tools`

`add_dirs` is for sessions that need write access to directories
outside `cwd`. SDD nodes operate strictly in `cwd` (the user-chosen
target repo). Adding `add_dirs` speculatively would be cargo-culting
and would invite mistakes in copied factories.

`allowed_tools` is meaningful under `accept_edits`. Under
`bypass_permissions` it is redundant — the CLI already grants every
tool. Setting it would be misleading: a reader might think the list
constrains the session. It does not.

We document both omissions in `examples/sdd.md` so future maintainers
do not pile them on speculatively.

### Decision: Sentinel-emission contract is prompt-level, mandated by spec

Each node's prompt MUST instruct the model to end its final assistant
text with one of:

```
MINIFAC_STATUS: succeeded
```

or

```
MINIFAC_STATUS: failed
REASON: <single line describing what failed>
```

The exact wording inside each prompt is implementation (it can be
phrased per-node, mentioning that node's responsibility). The spec
binds:

- The sentinel must be the *final* thing in the assistant text.
- On failure, a `REASON:` line follows on the next line.
- Each node's prompt must instruct its model on this contract.

The spec also drops the "exit 0 / exit non-zero" language from the
"SDD factory per-node responsibility" requirement. Exit codes remain
the executor-level fallback (per the `node-executor` spec) but the
factory does not rely on them; nothing in the factory's contract
references them. This is the cleaner story: one signaling mechanism
to reason about per factory node.

**Why prompt-level rather than executor-level injection:** The
executor deliberately does not inject sentinel instructions into the
prompt (see `node-executor` spec rationale). Auto-injection would
break the snapshot test and the contract that the prompt is the
user-authored agreement with the model. So the factory has to do it.

**Why also bind the contract in the spec:** Without a spec
requirement, a future maintainer rewriting the prompts could
accidentally drop the sentinel instructions and the factory would
silently regress to "exits 0 with no work done." The spec catches
this drift.

### Decision: `examples/sdd.md` ships a copy-paste sentinel block

Users editing the factory for their own changes need to know the
sentinel format without reading the executor source. `examples/sdd.md`
gains a short "Status signaling" section with the regex, a short
explanation, and a copy-paste block they can drop into a custom node's
prompt. This is documentation, not the binding contract — the binding
contract lives in the `sdd-factory` spec.

### Decision: Test scope

`src/factory/sdd-example.test.ts` is extended with two assertions:

- Each of the four nodes has
  `with.permission_mode === "bypass_permissions"`.
- Each node's prompt (a string in `with.prompt`) contains the literal
  substring `MINIFAC_STATUS`.

The substring check is a cheap proxy for "the prompt instructs the
model on the sentinel contract." A future prompt rewrite that drops
the instruction fails the test loudly.

We do not test the sentinel regex against synthetic prompt output. The
sentinel parsing is covered in the executor's own test suite (per
`node-executor` spec scenarios).

We do not add an end-to-end smoke test that runs the SDD factory.
That costs real API credits and is not what unit tests are for.

### Decision: Backwards compatibility / migration

`examples/sdd.yaml` is a template, not a runnable singleton. Users
copy it. Users who copied before this change will be running on the
old contract:

- No `permission_mode` in `with:`, so the strict-deny default applies.
- Prompts using "exit 0 / non-zero" language, so the model has no
  reason to emit the sentinel.

We cannot help them retroactively. `examples/sdd.md` gains a single
paragraph migration note pointing at the two edits they should make
to their copies (`permission_mode: "bypass_permissions"` and rewriting
the prompt's status language). This is a courtesy, not a guarantee.

## Risks / Trade-offs

- **[`bypass_permissions` widens blast radius on the user-chosen cwd]**
  → Mitigation: documented explicitly in the spec and in
  `examples/sdd.md`. The field name itself is the warning. The
  user-trust-cwd framing makes the contract legible to anyone reading
  the YAML. We accept this tradeoff because the alternative is a
  brittle allowlist that breaks the moment the verify commands grow a
  new sub-tool.
- **[Model ignores the sentinel instructions and the run reports the
  wrong status]** → Mitigation: each prompt explicitly tells the model
  what to write. The `node-executor` spec defines a precise regex; we
  match it. If models drift, we have data and can either tighten the
  prompts or move to a sentinel-file in a follow-up change. There is
  no runtime guard against a stubborn model.
- **[Spec drift between `node-executor` and `sdd-factory`]** →
  Mitigation: the `sdd-factory` spec text references the
  `node-executor` spec's sentinel format by name and quotes the
  expected line shape, but does not redefine the regex. If the
  executor-level format ever changes, both specs have to be updated
  together — same posture as today.
- **[Users who already copied `sdd.yaml` see broken behavior and
  don't know why]** → Mitigation: the migration paragraph in
  `examples/sdd.md`. We cannot reach existing copies, but anyone
  rereading the docs finds the fix immediately.
- **[Prompt rewrites accidentally drop the sentinel instruction]** →
  Mitigation: the `sdd-example.test.ts` substring check on each
  prompt fails the build. The spec scenario also documents the
  requirement.

## Migration Plan

No data migration. No deployed users.

Editing `examples/sdd.yaml` is a single PR. The structural test
catches accidental drift. The spec change locks the contract.

Users with pre-existing copies of `sdd.yaml` find the migration
paragraph in `examples/sdd.md` and apply two edits per copy. We
publish no script for this — the change set per copy is small enough
that a manual edit is correct and educational.

## Open Questions

- **Should the canonical SDD spec recommend a model knob (e.g.
  `model: "claude-opus-4-5"`) for the longer-running `apply` node?**
  Defer — that is a separate tuning question, not part of the
  authority/sentinel story. Today no node sets `model:` and that is
  out of scope.
- **Should `archive` use `accept_edits` instead?** Archive runs
  `openspec archive`, which is a Bash invocation. Under
  `accept_edits` we would still need `Bash(openspec:*)` in
  `allowed_tools`. Same tradeoff as the other nodes; pick the same
  posture for consistency.
- **Should we add a per-prompt sentinel preamble in `examples/sdd.md`
  so users can drop a copy-paste block at the bottom of every node's
  prompt?** The proposal includes the block as documentation. The
  binding instruction stays inside each node's prompt; the doc gives
  one source the user can lift.
- **Native `shell` executor for `verify`.** Out of scope; tracked as
  its own future change.
- **Factory-level `cwd:` default and templating.** Out of scope;
  tracked as their own future changes.
