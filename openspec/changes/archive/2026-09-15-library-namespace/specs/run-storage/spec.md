## ADDED Requirements

### Requirement: Schema v5 adds the library pin to `runs`

minifac SHALL ship a fifth SQL migration
`src/storage/migrations/0005_add_run_library.sql` containing:

```sql
ALTER TABLE runs ADD COLUMN library_repo TEXT;
ALTER TABLE runs ADD COLUMN library_ref TEXT;
ALTER TABLE runs ADD COLUMN library_sha TEXT;
```

mirrored as an entry in the inline `MIGRATIONS` array with
`version: 5` and `name: "add_run_library"`.

`CreateRunInput` SHALL grow an optional `library?: { repo, ref, sha }
| null` field, persisted into the three columns (`NULL` when omitted
or `null`). `StoredRun` SHALL grow `library: { repo, ref, sha } |
null`, non-null only when all three columns are set. Pre-v5 rows
SHALL read back with `library: null`. `minifac runs --json` SHALL
include each run's `library`.

#### Scenario: Fresh database picks up v5

- **WHEN** the adapter opens a brand-new database file
- **THEN** every migration through version `5` is applied, the
  `runs` table has `library_repo`, `library_ref`, and `library_sha`,
  and `schema_version.version` equals `5`

#### Scenario: Existing v4 database is migrated to v5

- **WHEN** the adapter opens a database at version `4` containing a
  run row
- **THEN** the migration is applied, `schema_version.version` is `5`,
  and the existing run reads back with `library: null`

#### Scenario: createRun round-trips the pin

- **WHEN** the caller creates a run with `library: { repo:
  "acme/lib", ref: "v0.1.0", sha: <40 hex> }`
- **THEN** `getRun` and `listRuns` return that `library` value
