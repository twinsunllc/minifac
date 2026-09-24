## Why

Nothing sets the effort level a factory node runs at, and the default
differs by model and by Claude Code build. So the level a node actually
ran at is unknown, and that confounds any model-to-model comparison
(SCARIFW-1474). Scarif's worker gains an optional per-node `with.effort`
and records the level each dispatch ran at. minifac's `claude` executor
`with:` schema is the one the worker's schema is kept at parity with
(strict: an unknown key fails the node), so minifac gains the same key.
A factory that sets it then behaves the same on both executors.

The captain's ruling on the ticket is that effort is NOT pinned yet: the
key is optional, blank means the Claude Code default, and no factory
sets it in this change.

## What Changes

- **ADDED** `node-executor` "Optional per-node effort in claude executor
  `with:`": an optional string `effort`. It is trimmed. Blank or absent
  emits no flag. One of `low`, `medium`, `high`, `xhigh`, `max` (the levels
  `claude --help` lists for `--effort`) emits `--effort <level>` right
  after `--model` and before the authority flags and `with.args`. Any
  other value fails with `invalid_with` and spawns nothing.

## Impact

- Affected specs: `node-executor`
- Affected code: `src/executor/claude.ts` (`WithSchema`, `buildCliArgs`,
  header comment)
- No breaking change. A node that does not set `effort` spawns with
  exactly the argv it did before.
- minifac does not record the effective effort. That is Scarif's worker's
  accounting, as cost is.
