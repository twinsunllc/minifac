## Context

See `proposal.md` and `docs/decisions/0055-Value-Edges-And-Node-Routing.md`,
which records the decision in full, including the `routes:`/`next:` design
and the answers to #54's four questions.

## Decisions

- **One module.** `src/factory/value-edges.ts` holds the condition schema
  (`ValueConditionSchema`), the key helper (`edgeWhenKey`), run-time
  matching (`resolveOutputPath`, `conditionMatches`) and the load-time
  validator (`validateValueEdges`). `schema.ts` imports the schema at
  runtime; `value-edges.ts` imports the factory types only, so there is no
  runtime cycle.
- **Error messages.** `when` is a zod union of the literal enum and the
  condition. Only a load error's first issue is shown, so the union's
  `errorMap` reports the condition's own issue for a mapping and the list
  of supported values for anything else.
- **Where the load check runs.** In `validatePostSchema`, after step
  inlining and after `validateResume`, so step-declared outputs count.
- **Schema path check.** Direct keywords only (`false`, `type`,
  `properties`, `patternProperties`, `additionalProperties`, leaf
  `const`/`enum`). Keywords are conjunctive, so this never refuses a
  possible path. `$ref`/`anyOf`/`allOf` paths are accepted.
- **Runner.** Selection happens before the existing budget loop, which is
  unchanged, so an exhausted matched edge cannot fall back. Values are read
  from the indexed outputs (`validatedIndex`), so a schema-mismatched value
  never matches. Each tested output is read and parsed once per completion.
- **Viewer.** `edgeStyle` maps an object `when` to `edge-path on-value`
  with its own marker; the condition text is a `<title>` tooltip.
