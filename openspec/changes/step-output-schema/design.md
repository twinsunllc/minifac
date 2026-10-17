## Context

See `proposal.md` and `docs/decisions/0054-Step-Output-Schema.md`, which
records the decision in full.

## Decisions

- **Library.** Ajv 8, `Ajv2020` from `ajv/dist/2020.js`, one shared
  instance in `src/factory/output-schema.ts` with `strictSchema: true`,
  `strictTypes`/`strictTuples`/`strictRequired` off, `allErrors: true`,
  `validateFormats: false`, `addUsedSchema: false`. Compiled validators
  are cached per schema object.
- **Load-time check.** A `superRefine` on `OutputDefSchema` (zod's
  `discriminatedUnion` accepts only plain object members, so the
  refinement sits on the union). Both `StepSchema.outputs` and
  `NodeSchema.outputs` reuse `OutputsMapSchema`, so steps, factories and
  `extends:` layers are covered by the same code and each loader's
  existing ZodError path names its file.
- **Inheritance.** `inlineStepIntoNode` sets
  `out.outputs = node.outputs ?? step.outputs`. Layers are merged before
  inlining, so the `extends:` rule needs no code.
- **Runtime.** `checkValue` validates the parsed value and returns a
  `mismatch`; `ValidateOutputsResult` gains `mismatched` and
  `violations`. `run.ts` checks `missing` first (unchanged), then
  `mismatched`. The nudge loop looks only at `missing`, so a mismatch
  never nudges.

## Risks

- Strict schema refuses custom keywords (`x-foo`). Loosening later is a
  one-line option change.
- No nudge on a mismatch: an agent gets no in-turn chance to fix a bad
  value. Recorded as deferred in the ADR.
