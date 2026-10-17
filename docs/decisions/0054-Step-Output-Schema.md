---
status: accepted
date: 2026-10-17
supersedes: []
superseded-by: null
tags: [decision]
---

# 0054: Step-declared outputs, validated by JSON Schema

## Context

A step could not declare `outputs:`. Every node that used a judging step
re-declared `result: { type: value, required: true, shape: object }`, and
the runner checked only that `result.json` parsed as JSON (`shape:` is
reserved and ignored). Enums, required fields and maps such as
`head_sha` lived as prose in the prompt, so a node could claim success
with `{"verdict": "maybe"}` and the graph routed on it
(scarif-factory FINDINGS F28; twinsunllc/minifac#43; SCARIFW-2250).

[[0052-On-Error-Edges]] gave nodes three outcomes, `success`, `failure`
and `error`. A bad result has to land on one of them.

## Decision

### Where outputs are declared

A step file MAY declare a top-level `outputs:` map with the same schema a
node uses (`OutputsMapSchema`). A `type: value` output, on a step or on a
node, MAY carry `schema:`, a JSON Schema (draft 2020-12, an object or a
boolean).

**Inheritance.** At inline time a `uses:` node that declares no
`outputs:` carries its step's whole `outputs:` map, schemas included. A
node that declares `outputs:` keeps exactly its own map. The two are never
merged: a node that wants one more key re-declares the whole map.

**Under `extends:`.** Layers merge before steps are inlined, and a
derived layer that redeclares a node replaces it whole (`factory-schema`
"Replace-at-node-level merge semantics"). So a redeclared
`uses:` node without `outputs:` carries its step's outputs, never the
base node's. A node the derived layer does not redeclare keeps the base
layer's node as resolved, own `outputs:` or inherited. No new merge rule
was needed.

### The validator

**Ajv 8**, through its draft 2020-12 entry point (`Ajv2020` from
`ajv/dist/2020.js`). It is the maintained reference JavaScript validator
and was already in the tree (8.20.0) through `@modelcontextprotocol/sdk`;
it is now a direct dependency, with no new packages in the lockfile. One
shared instance (`src/factory/output-schema.ts`):

- `strictSchema: true`: an unknown keyword is a compile error, so a typo
  such as `requried` is a load error instead of a schema that checks
  nothing. A custom annotation (`x-foo`) is refused for the same reason.
- `strictTypes`, `strictTuples`, `strictRequired`: off. Ajv's other
  strict checks refuse schemas that are valid 2020-12, such as
  `properties` without `type: object`.
- `allErrors: true`: every violation is reported.
- `validateFormats: false`: `format` is an annotation, as the 2020-12
  format-annotation vocabulary defines it. No format plugin is loaded.
- `addUsedSchema: false`: a schema's `$id` is not registered on the shared
  instance, so two steps declaring the same `$id` do not collide.

### When a schema is checked

**At load.** A zod refinement on `OutputDefSchema` compiles the schema. An
invalid one is a schema issue at `outputs.<key>.schema` with the message
`invalid JSON Schema: <ajv message>`. The existing error paths then name
the file: a `StepLoadError` with the step's path (surfaced through a
factory's `uses:` as a `FactoryLoadError` naming the factory and the step
path), or a `FactoryLoadError` naming the factory or `extends:` layer file
for a node's own outputs.

**At node completion.** The outputs validator parses each present value
output and validates it against its schema. A mismatching value is not
indexed and is not "missing", whether or not the output is required.

### A mismatch is a failure, not an error

On a node whose terminal status is `succeeded`, a mismatch sets the status
to `failed` with outcome **`failure`**, so the node routes `on_failure`
even when it declares `on_error`.

The node ran and returned a result; the result is wrong. That is the
judged-failure side of [[0052-On-Error-Edges]], and it is what a revise
loop on `on_failure` exists to handle. `missing_required_output` stays an
`error`: there the node produced no judgment at all. When both apply, the
missing output wins and the node is an `error` with reason
`missing_required_output`.

The reason names the first violation:

```
output_schema_mismatch: output "<key>" at <json-pointer>: <keyword> (<ajv message>)
```

The pointer is Ajv's `instancePath`, `/` for the root. A `required`
violation points at the object missing the property; the message names
it. A stderr line per violation and a `status` event
(`meta.reason: "output_schema_mismatch"`, `mismatched_outputs`,
`schema_errors`, `outputs_dir`, `partial_index`) carry the full list, as
the `missing_required_output` override does.

On a node that already **failed**, a mismatch changes nothing: the node
keeps its own reason, the value is not indexed, and an `outputs_warning:`
stderr line lists the violations ([[0041-Failed-Node-Outputs]]).

A node or step with no `schema:` takes exactly the code path it took
before.

## Rejected alternatives

- **Deep-merging a node's `outputs:` over the step's.** It makes the
  resolved map depend on two files and on merge rules for every field.
  Wholesale replace is what `extends:` already does at node level.
- **Making a mismatch an `error`.** An error means no judgment could be
  produced; routing a wrong-shaped judgment to `on_error` would send it
  past the revise loop that can fix it.
- **Giving `shape:` a meaning.** It is already accepted with any value, so
  assigning semantics to it would change what existing factories mean.
  `schema:` is new and explicit; `shape:` keeps its MCP-only role.
- **Ajv's full `strict: true`.** It refuses valid 2020-12 schemas (see
  above).

## Deferred

- **Nudging on a mismatch.** The nudge loop fires for missing outputs
  only; an agent that writes a bad value is not asked to correct it in
  turn.
- **Validating in the MCP report tool.** The `mcp__minifac__report_<key>`
  tool could reject a bad value at the call. Not built here.
- **Schemas on scarif-workflows steps.** The library adopts this in its
  own release.

## Consequences

- A judging step can state its contract once, and every node using it is
  checked against it.
- A custom keyword in a schema is a load error.
- Routing on a bad result changes only for nodes that declare a schema.

## Related

- [[Step]]
- [[Outputs]]
- [[0052-On-Error-Edges]]
- `openspec/changes/step-output-schema/`
