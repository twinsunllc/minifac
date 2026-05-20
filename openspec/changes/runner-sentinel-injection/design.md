## Context

The `claude` executor (`src/executor/claude.ts`) already owns one half
of the sentinel contract: it parses the model's final assistant text
for a `MINIFAC_STATUS:` marker and lets the marker beat the CLI exit
code in both directions. The *other* half — teaching the model to emit
the marker — currently lives in each factory's prompts.

Decision 0007 (`docs/decisions/0007-Sentinel-Runner-Injects.md`) makes
the runner the single owner of both halves. The executor injects the
"here's how to emit the sentinel" mechanics into every prompt it sends
to the CLI, and continues to parse the response the same way.

This change is small in scope (one source file, one example factory,
two spec files, one structural test). The design notes below pin the
shape of the injected block, the opt-out knob, and the migration of
the shipped SDD factory.

Constraints from `CLAUDE.md`:

- No premature subsystems. This is the existing `node-executor`
  capability picking up an extra concern.
- No anthropomorphic metaphors. The opt-out knob is named after what
  it does (`emit_sentinel_instructions`), not "personality" or "mode".
- Snake_case YAML.
- No new runtime dependencies.

## Goals / Non-Goals

**Goals:**

- The `claude` executor auto-appends a canonical sentinel-instruction
  block to every prompt it sends. The block teaches the model the
  regex, where the marker must appear, the success and failure
  shapes, and that the marker must be the last thing in the message.
- A per-node opt-out (`emit_sentinel_instructions: false`) is
  available for future executors that don't want it, or for
  hand-crafted experiments.
- The sentinel parse path is unchanged — the executor's response
  handling stays exactly as it was.
- `examples/sdd.yaml` is migrated to the new shape: per-node criteria
  stay inline; the `## Status signaling` boilerplate is removed.
- Spec deltas document the new contract precisely enough that a future
  reader can reconstruct the wire format from the spec.

**Non-Goals:**

- No change to the `NodeExecutor` interface, `NodeEvent` shape, or
  `RunContext` shape.
- No change to other shipped factories (`examples/hello.yaml` is
  unaffected and stays unchanged).
- No `shell`/`codex` executor work.
- No change to the sentinel regex itself. Decision 0007 explicitly
  leaves regex changes to future proposals; this one only relocates
  the instructions that teach the model the existing format.

## Decisions

### Decision: Append the sentinel block to the prompt string before stream-json framing

The injection point is `buildStreamJsonInput` (the function that wraps
the `history + prompt` into a stream-json user message). The
sentinel block is concatenated onto the `prompt` string, after a
blank-line separator, before the function builds the stream-json
envelope. This keeps the change localized: one helper, one new
constant string, one call site.

The injected block is a single multi-line template literal exported
from `claude.ts` (e.g. `SENTINEL_INSTRUCTIONS`). Exported so the
snapshot test can verify identity (the test asserts the constant
appears verbatim in the constructed prompt) and so future format
changes are a one-line diff in that constant plus a snapshot update.

**Why concat the prompt string rather than send a second user message
in the stream-json envelope:** the executor today sends exactly one
user message. Splitting into two would change the wire format more
than this change earns. The model treats the appended block as part
of the same turn-taking message either way.

**Why before-the-envelope (not after):** appending to `prompt` before
the envelope is built means the existing `buildStreamJsonInput`
contract (one string → one envelope line) is unchanged. The injected
block is just part of the prompt the executor sends, from the
envelope's perspective.

### Decision: One canonical block, defined verbatim in source

The injected block is hard-coded in `claude.ts` as a single multi-line
string constant. It describes:

- the exact two acceptable endings (`MINIFAC_STATUS: succeeded` and
  `MINIFAC_STATUS: failed\nREASON: <one line>`),
- that the line must appear in the model's final assistant message,
- that the line must be the last thing in the message.

It does **not** include the literal regex pattern — instructing the
model in prose is more robust than asking it to satisfy a regex it
can't introspect. The regex is the executor's parse rule, not the
model's authoring guide. The two are kept in sync because the
constant and the `SENTINEL_REGEX` live in the same file, with a
comment cross-referencing them.

**Alternatives considered:**

- **Template from a file (`prompts/sentinel-block.md`).** Cleaner
  separation, more moving parts. Not worth it for ~10 lines of text
  that change once a year.
- **Per-node override of the block text.** Premature flexibility. The
  opt-out knob covers the "don't inject anything" case; a "inject
  this other thing" case has no concrete use case yet.
- **Render-time variables in the block (e.g. include the node id).**
  Considered for diagnostic richness; rejected because the model
  already sees the node id in `ctx.history`. Keep the block static.

### Decision: Opt-out knob defaults to `true` and is strict-validated

`emit_sentinel_instructions: bool` joins the existing `WithSchema`
strict object. The default is `true` — i.e. the executor injects the
block unless the node explicitly says otherwise. The field uses
`.optional()` so omitting it from YAML works (defaults applied
inside the executor logic, not via zod `.default()`, to keep the
parsed shape symmetric with the existing fields that omit defaults).

Validation:

- Strict object: an unknown field still fails as today.
- Type: boolean. Any non-boolean fails with `invalid_with` meta, same
  pathway as the other knobs.

**Why default to on:** Decision 0007 says the factory should not have
to author the mechanics. Making the default opt-in would mean every
shipped factory has to add `emit_sentinel_instructions: true` to get
the standard behavior — which is the opposite of what the decision
wants. The default is the common path.

**Why a boolean field rather than auto-detection (e.g. "skip injection
if the prompt already contains `MINIFAC_STATUS`"):** auto-detection
makes the contract implicit and surprising. A factory author who
copy-pasted a sentence containing `MINIFAC_STATUS` for *documentation*
purposes would suddenly get no auto-injection. Boolean is explicit and
diff-visible.

### Decision: `examples/sdd.yaml` keeps per-node criteria inline

Each node's prompt currently has two roles:

1. **Mechanics** — the `## Status signaling` block (the regex, the
   wire shape, "must be last in the message").
2. **Criteria** — what success and failure *mean* for this node
   ("success: every verify command exited 0; failure: any command
   exited non-zero, REASON should name the failing command").

This change removes (1) from the YAML — that's the runner's job now.
It keeps (2) inline, in prose, immediately above the responsibilities
or interleaved with them as already written. The criteria are
factory-specific (success/failure semantics differ per phase) and
stay with the factory.

**Concretely, per node:**

- **propose:** criteria already implicit ("got `openspec validate` to
  exit 0 and every required artifact is on disk"). Keep as-is; the
  `## Status signaling` block deletion is the only change.
- **apply:** criteria already implicit ("every checkbox in
  `tasks.md` is `- [x]`"). Keep; delete the block.
- **verify:** criteria already implicit ("every verify command exited
  0"). Keep; delete the block. The verify-prompt block currently
  emphasizes that the REASON line must be diagnosable — that bit of
  prose moves up into the node's own criteria paragraph so the model
  still sees it.
- **archive:** criteria already implicit ("`openspec archive` exited
  0 AND the subsequent `git commit` exited 0"). Keep; delete the
  block.

The wording stays intentionally lossless: the model still sees, in
prose, what "succeeded" and "failed" mean for its node. The shipped
prompt just stops re-stating the sentinel regex and the
"must-be-last" mechanics.

### Decision: `examples/sdd.md` migration note + drop the "drop this block in your custom node" recipe

`examples/sdd.md` today documents the `## Status signaling` block in
two places:

1. A `## Status signaling` section explaining the regex, precedence,
   and the two literal endings.
2. A "drop this block at the end of your custom prompt to stay
   compliant" recipe.

Both are revised:

- The `## Status signaling` section keeps the regex and precedence
  documentation (still useful reference) but notes that **the runner
  injects the instructions; the factory only declares criteria**.
- The "drop this block" recipe is removed and replaced with a note
  that custom prompts get the sentinel mechanics for free; if a
  factory author explicitly opts out via
  `emit_sentinel_instructions: false`, they own the mechanics.

A short migration note is added pointing copiers of the prior
`examples/sdd.yaml` at how to strip their boilerplate (one diff per
node — remove the `## Status signaling` block; everything else is
unchanged).

### Decision: Snapshot the constructed prompt, not just argv

The existing snapshot test pins `cliArgs`. This change adds a
snapshot of the *stdin payload* (the stream-json line written to the
child's stdin) for a representative `{ prompt: "do X", history: [] }`
case so future drift in the injected block is deliberate. The
snapshot file lives alongside the existing snapshots; the test reads
through `buildStreamJsonInput` (the same function the executor calls
in production) so any code path the runtime uses is what's snapshotted.

Plus a second snapshot case: `emit_sentinel_instructions: false`,
asserting the constructed payload contains the bare prompt with no
appended block.

### Decision: Drop `MINIFAC_STATUS`-substring assertion from the SDD structural test

`src/factory/sdd-example.test.ts` currently asserts that each of the
four SDD node prompts contains the literal substring `MINIFAC_STATUS`.
After this change, the prompts won't — the substring is in the
runner's injected block, not the YAML. The assertion is replaced by
a per-node criteria-presence assertion: each prompt mentions its
success criterion in prose (e.g. the `verify` prompt mentions "verify
command"; the `archive` prompt mentions "openspec archive" and
"git commit"). Concretely, the test asserts a small set of substrings
specific to each node's domain so a regression that accidentally
deletes the criteria along with the boilerplate is caught.

## Risks / Trade-offs

- **[Auto-injection surprises factory authors]** → Mitigation: default
  documented prominently in `examples/sdd.md` and the wire-format
  comment block at the top of `claude.ts`. The opt-out knob is
  explicit and discoverable in the schema. Authors who want the
  prior behavior (no injection) flip one boolean.
- **[Model ignores the injected block under heavy prompts]** →
  Mitigation: the parse path is unchanged. If the model declines to
  emit the marker, the executor falls back to exit-code semantics
  exactly as today. The risk surface is no worse than the status quo;
  in practice the injected block likely *increases* reliability
  because it appears near the model's final turn (concatenated to the
  prompt-end).
- **[Future sentinel-format change still needs a coordinated update]**
  → Mitigation: by centralizing the instructions, future changes
  shrink from "every shipped factory plus the executor" to "one
  constant plus the executor." This is exactly the consolidation
  Decision 0007 buys.
- **[Snapshot drift on prompt-change PRs]** → Mitigation: the
  snapshot is in-source; any change to the constant produces a
  visible-in-review snapshot diff. That is the desired behavior.
- **[A node with `emit_sentinel_instructions: false` *and* no
  sentinel mechanics in its prompt becomes silently dependent on
  exit codes]** → Documented behavior, not a bug. The opt-out is for
  callers who know what they're doing (e.g. a future `shell` executor
  that has a different status mechanism). The wire-format comment
  block flags this trade-off.

## Migration Plan

No data migration; no deployed users.

- `examples/sdd.yaml`: one diff per node — delete the `## Status
  signaling` block. The `examples/sdd.md` "Migration note" section
  gains an entry telling copiers of older `sdd.yaml` files to strip
  their boilerplate. Existing copies that *still carry* the
  boilerplate continue to work — the runner injects the same block
  on top, the model sees the (redundant) instructions twice, the
  sentinel still emits correctly, no functional difference. Strip is
  an aesthetic / line-count migration, not a correctness one.
- `examples/hello.yaml`: untouched. No sentinel block to remove. The
  auto-injected block is harmless (the prompt isn't sentinel-oriented;
  the model can ignore the instructions and the executor falls back
  to exit-code semantics).
- Tests: the structural assertion in `sdd-example.test.ts` is
  updated to drop the `MINIFAC_STATUS`-substring check and pick up
  per-node criteria checks. The snapshot in `claude.test.ts` adds
  one new case.

## Open Questions

- **Should the injected block be Markdown-formatted (current draft) or
  bare prose?** Markdown lets the model see explicit code-block
  delimiters around the marker syntax; bare prose is one less thing
  to render in stream-json. Going with Markdown for v0 (matches the
  prior factory style); revisit if a future model regresses on it.
- **Should `emit_sentinel_instructions: false` cause the executor to
  also skip sentinel *parsing*?** Argued: a node that opts out of
  injection is presumably not going to emit the marker, so
  parse-skipping is consistent. Counter: parsing the marker is cheap
  and the symmetry is convenient ("the parser always runs"). Going
  with "parser always runs" for v0 — the opt-out is a prompt-side
  knob only. Reconsider when a real second executor lands.
- **Does the brief schema need a parallel knob?** No. Briefs are out
  of scope for this change and brief authors never write sentinel
  instructions under the decision-0007 model. The brief schema work
  is the next change after this one.
