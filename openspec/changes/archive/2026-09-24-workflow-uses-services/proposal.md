## Why

Scarif's EC2-per-job lane (scarif-spec `openspec/changes/ec2-per-job-lane`,
merged dfca9bde) lets a factory repo's `factory.yaml` manifest define
services (a database, a cache) and lets each workflow select the ones its
jobs need with a top-level `uses_services:` list (design D5; "Rulings
(captain, 2026-09-24)" #3; factory-repo-contract "A factory MAY define
services in the manifest, and a workflow selects the ones its jobs
need"). Task 3.1 asks minifac to accept that key and to prove that a
`services:` block in `factory.yaml` does not break loading
(SCARIFW-1531).

minifac's workflow schema is strict, so today `uses_services:` fails the
load with `Unrecognized key(s)`. Scarif-web (SCARIFW-1533) and the worker
(SCARIFW-1539) act on the list; minifac only has to accept and carry it.

## What Changes

- **ADDED** `factory-schema` "Workflow `uses_services:` top-level
  field": an optional list of unique, non-empty service names. It is
  carried on the resolved factory, ignored by the runner, and not
  inherited through `extends:`.
- **MODIFIED** `factory-schema` "Factory `extends:` top-level field":
  the documented top-level key set gains `uses_services`. Any other
  unknown top-level key, `services:` included, is still refused.
- A `services:` block in a factory repo's `factory.yaml` is tolerated.
  minifac reads only `library:` from that file, so this needs no code;
  a test proves it.

## Impact

- Affected specs: `factory-schema`
- Affected code: `src/factory/schema.ts`, `src/factory/extends.ts`
- No breaking change. Workflows without the key load as before.
- The scarif-worker minifac pin is not moved here; SCARIFW-1539 does
  that after merge.
