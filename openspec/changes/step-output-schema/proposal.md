## Why

A step cannot declare `outputs:`, so every node using a judging step
re-declares `result: { type: value, required: true, shape: object }`, and
the runner checks only that the value parses. Enums, required fields and
maps live as prose in the prompt, and a node that writes
`{"verdict": "maybe"}` routes as a success (scarif-factory FINDINGS F28;
twinsunllc/minifac#43; SCARIFW-2250).

## What Changes

- **MODIFIED** `step-schema` "Step file format": `outputs` joins the
  accepted top-level key set.
- **ADDED** `step-schema` "Step-declared outputs": a step's `outputs:` uses
  the node schema; an invalid entry is a `StepLoadError` naming the step.
- **MODIFIED** `factory-schema` "Node definition" and "Node `uses:` field as
  an alternative to inline executor": a `uses:` node without `outputs:`
  carries the step's map; a node's own map wins wholesale; the `extends:`
  rule follows from replace-at-node-level.
- **MODIFIED** `factory-schema` "`OutputDef` discriminated types": a value
  output accepts `schema:` (JSON Schema draft 2020-12); an invalid schema
  is a load error naming the file.
- **ADDED** `graph-runner` "Output schema validation at node completion":
  a mismatch on a succeeded node is `failed` / outcome `failure` with
  reason `output_schema_mismatch: ...` naming pointer and keyword; a
  missing required output still wins as an `error`.

## Impact

- `src/factory/output-schema.ts` (new), `src/factory/schema.ts`,
  `src/step/schema.ts`, `src/step/inline.ts`, `src/runner/outputs.ts`,
  `src/runner/run.ts`; `ajv` becomes a direct dependency (already in the
  lockfile).
- Opt-in: only steps and nodes declaring `outputs:` on a step or
  `schema:` see new behaviour. No runs.db schema change.
- Decision record: `docs/decisions/0054-Step-Output-Schema.md`.
