## 1. Dependency and validator

- [x] 1.1 `package.json`: `ajv ^8.20.0` as a direct dependency (no new
      lockfile packages)
- [x] 1.2 `src/factory/output-schema.ts`: shared `Ajv2020`,
      `checkOutputSchema`, `validateOutputValue`, `describeViolation`

## 2. Schema

- [x] 2.1 `src/factory/schema.ts`: `schema:` on `OutputValueSchema`,
      refinement on `OutputDefSchema`
- [x] 2.2 `src/step/schema.ts`: `StepSchema.outputs`

## 3. Inheritance

- [x] 3.1 `src/step/inline.ts`: `node.outputs ?? step.outputs`

## 4. Runtime

- [x] 4.1 `src/runner/outputs.ts`: `mismatched`, `violations`
- [x] 4.2 `src/runner/run.ts`: `output_schema_mismatch` override on
      succeeded nodes (`failed` / `failure`); warning on failed nodes

## 5. Tests

- [x] 5.1 `src/factory/output-schema.test.ts`: valid, invalid,
      unknown keyword, pointer/keyword for enum, required, root type
- [x] 5.2 `src/factory/schema.test.ts`: `schema:` accepted, invalid
      rejected at path `schema`
- [x] 5.3 `src/step/loader.test.ts`: step outputs load; invalid schema is
      a `StepLoadError` naming the step file
- [x] 5.4 `src/step/inline.test.ts`: inheritance, node override
- [x] 5.5 `src/factory/uses-loader.test.ts`: resolved factory inherits;
      invalid step schema and invalid inline schema name the files
- [x] 5.6 `src/factory/extends.test.ts`: redeclared node takes the step's
      outputs; untouched node keeps the base's; invalid schema names the
      layer
- [x] 5.7 `src/runner/outputs.test.ts`: matched, mismatched, optional,
      absent, no schema
- [x] 5.8 `src/runner/run.output-schema.test.ts`: pass, mismatch routes
      `on_failure` with outcome `failure` in runs.db, missing wins,
      failed node keeps its reason, no schema unchanged

## 6. Docs

- [x] 6.1 `docs/decisions/0054-Step-Output-Schema.md`
- [x] 6.2 `docs/concepts/Step.md`, `docs/concepts/Outputs.md`
- [x] 6.3 `CHANGELOG.md` `[Unreleased]`
