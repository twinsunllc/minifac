## Why

The `MINIFAC_STATUS:` sentinel is how a spawned `claude` session signals
work-level success or failure to the runner — it's a load-bearing piece
of the executor contract. But the *instructions* that teach the model
to emit the sentinel currently live in every factory's prompt. The
shipped `examples/sdd.yaml` carries the same ~20-line `## Status
signaling` block on each of its four nodes — ~60 lines of identical
boilerplate distributed across the YAML.

Two problems flow from that:

1. **Cost-of-change.** A future sentinel-format tweak (the regex
   already had to be narrowed once — `\s*` → `[ \t]*` so the REASON
   capture group worked) would require touching every shipped factory
   in lockstep. The shipped SDD prompt has already been edited twice
   for sentinel reasons and once for archive-commit reasons; that's a
   pattern, not an outlier.
2. **Drift risk.** Each factory's copy of the boilerplate can drift
   from the canonical regex, and brief authors / factory copiers have
   to read and preserve a block they did not author.

Decision 0007 (`docs/decisions/0007-Sentinel-Runner-Injects.md`) says:
the runner auto-injects the sentinel mechanics; the factory keeps only
the per-node success/failure *criteria*. This proposal implements that.

## What Changes

- **`src/executor/claude.ts`** auto-appends a standard sentinel-emission
  instruction block to every prompt it sends, before serializing the
  stream-json envelope. The block teaches the model:
  - the canonical regex (the same `/^MINIFAC_STATUS:[ \t]*...` that
    `SENTINEL_REGEX` already matches against the response),
  - that the sentinel must appear in the final assistant message,
  - the success shape (`MINIFAC_STATUS: succeeded`) and failure shape
    (`MINIFAC_STATUS: failed\nREASON: <single line>`),
  - that the sentinel must be the last thing in the message.
- A new optional `with:` field, `emit_sentinel_instructions: bool`
  (default `true`), opts a node out of auto-injection. The field is
  parsed by the existing `WithSchema` and validated by zod alongside
  the existing knobs. When `false`, the executor sends the prompt
  unchanged; the executor still parses for the sentinel in the
  response (parsing behavior does not change).
- **`examples/sdd.yaml`** drops the `## Status signaling` block from
  each of the four nodes' prompts. The per-node success/failure
  *criteria* (e.g. "success means every verify command exited 0")
  remain inline so the model still knows what to report; only the
  sentinel mechanics move out.
- **`examples/sdd.md`** is updated to describe the new prompt shape
  (criteria in the factory, mechanics in the runner) and to remove the
  "drop this boilerplate block into your custom prompt" advice.
- **`openspec/specs/node-executor/spec.md`** is updated:
  - the "Status signaling via sentinel marker" requirement is
    MODIFIED to flip the contract — the executor SHALL inject the
    sentinel mechanics into outgoing prompts (it previously SHALL NOT
    modify the prompt) — and to describe the opt-out knob;
  - new scenarios cover the injected-block presence, the opt-out
    behavior, and the unchanged response-parse contract.
- **`openspec/specs/sdd-factory/spec.md`** is updated:
  - the "SDD factory prompts instruct the model to emit
    MINIFAC_STATUS" requirement is MODIFIED — the *factory* no longer
    instructs the model to emit the sentinel (the runner does); the
    factory's binding obligation is to declare per-node criteria. The
    `MINIFAC_STATUS`-substring assertion is removed from the spec.
- **`src/factory/sdd-example.test.ts`** drops the assertion that each
  prompt contains `MINIFAC_STATUS` (sentinel mechanics are now the
  runner's job) and gains a small per-node criteria assertion in its
  place.
- **`src/executor/claude.test.ts`** adds:
  - a snapshot of the constructed prompt with the injected block, so
    future format changes are deliberate;
  - a test that `emit_sentinel_instructions: false` sends the prompt
    unchanged;
  - reuses the existing sentinel-parse tests unchanged (parse path is
    not touched).

Explicitly **out of scope** (deferred to later changes):

- Brief schema, brief handling, factory-inputs work — next change.
- Other executor types (`shell`, `codex`). The opt-out knob is the
  hook future executors can use; this change does not ship them.
- Daemon / viewer / serve changes.
- A hook-enforced or callback-based sentinel transport (filed under
  `docs/Open-Questions.md`).

## Capabilities

### New Capabilities

<!-- None — both pieces live in existing capabilities. -->

### Modified Capabilities

- `node-executor`: the canonical executor capability flips the
  prompt-mutation contract for the claude executor (auto-inject the
  sentinel block by default; opt out via `emit_sentinel_instructions:
  false`). The `NodeExecutor` interface and `NodeEvent` shape do not
  change.
- `sdd-factory`: the shipped SDD prompts no longer need to instruct
  the model to emit the sentinel — that's the runner's job — but they
  retain the per-node success/failure criteria. The structural test's
  `MINIFAC_STATUS`-substring assertion is dropped; a criteria-presence
  assertion replaces it.

## Impact

- One file changes substantively in `src/`: `src/executor/claude.ts`.
  No new files, no new modules, no new runtime dependencies.
- `src/factory/sdd-example.test.ts` updates its existing assertions.
- `examples/sdd.yaml` and `examples/sdd.md` are edited; behavior of a
  copied SDD factory shrinks by ~60 lines but produces the same
  spawned-process effect (sentinel mechanics now come from the
  runner). Migration is one diff per node — strip the `## Status
  signaling` block — and is documented in `examples/sdd.md`.
- `examples/hello.yaml` is unaffected: it has no sentinel block today
  and does not need one tomorrow (the auto-injected block is harmless
  for prompts that don't otherwise rely on the sentinel; the response
  parse falls back to exit-code semantics when the model declines to
  emit the marker).
- The wire-format snapshot test gains one new snapshot (the prompt
  with the auto-injected block). The existing snapshots are
  unaffected because they test argv, not stdin payload.
