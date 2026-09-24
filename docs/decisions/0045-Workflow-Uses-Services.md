---
status: accepted
date: 2026-09-24
supersedes: []
superseded-by: null
tags: [decision]
---

# 0045: Accept a workflow's `uses_services:` and ignore it

## Context

Scarif's EC2-per-job lane (scarif-spec `openspec/changes/ec2-per-job-lane`)
lets a factory repo's `factory.yaml` manifest define services, such as a
MySQL database or a Valkey cache, that the worker starts beside a job
(design D5). Ruling 3 of that change ("Rulings (captain, 2026-09-24)") says
the manifest defines services and each workflow selects the ones its jobs
need with a top-level `uses_services:` list. Scarif-web reads the list when a
job is ordered (SCARIFW-1533), and the worker starts the services
(SCARIFW-1539).

The [[Factory]] schema is strict at the top level, so a workflow carrying
`uses_services:` failed to load with `Unrecognized key(s)`. The worker loads
every workflow through minifac, so minifac has to accept the key before
anything else in the lane can ship (SCARIFW-1531).

## Decision

- A workflow MAY declare `uses_services:`, a list of unique, non-empty
  strings. A scalar, a map (a workflow defining a service), an empty or
  non-string entry and a repeated entry are load errors that name the file
  and the `uses_services` key.
- minifac carries the list on the resolved factory
  (`LoadedFactory.factory.uses_services`) and does nothing else with it. No
  runner, executor or storage code reads it.
- It is **not inherited through `extends:`**. Only the loaded file's own key
  counts; a base's list is neither inherited nor merged. A workflow that
  needs services says so itself, so a reader of one file sees the whole
  selection. This matches how scarif-web reads the key (SCARIFW-1533).
- The top level stays strict. `uses_services` joins the documented key set;
  any other unknown key, `services:` included, is still refused on a
  workflow.
- minifac does not read `services:` in `factory.yaml`. That file is read
  only for its `library:` pin, so a `services:` block there needs no code.
  A test proves it.

## Rejected alternatives

- **Loosening `.strict()`** so any unknown top-level key passes. It would
  silently accept typos such as `inherits:` for `extends:`, which the
  strict schema exists to catch.
- **Inheriting through `extends:`**, like `name` and `brief`. Services cost a
  machine's time and memory; a selection that arrives silently from a base
  is one nobody chose. Scarif-web also reads only the file's own key, and
  two readings that disagree would start different services from the ones
  that were validated.
- **Checking names against the manifest, or against scarif-spec's
  `^[a-z][a-z0-9-]{0,30}$` pattern.** The manifest schema and its
  validation belong to Scarif, which refuses an unknown service when a job
  is ordered. Doing it here too would put a second copy of that schema in
  minifac, where it could drift from Scarif's.
