---
tags: [reference]
aliases: [config, configuration, config.yaml]
---

# Config

minifac reads two YAML files and one environment variable to determine where its
state lives and how runs behave. This page describes every key, the merge rules
between files, and the env vars that override them.

## File locations and precedence

| Layer | Path | Scope |
|---|---|---|
| Machine-wide | `~/.minifac/config.yaml` | All repos on this machine |
| Per-repo | `<repo-root>/.minifac/config.yaml` | One repo only |

Both files are optional. Missing files are not errors.

When the same key appears in both files, the per-repo file wins for
`worktrees_dir`, `default_branch`, and `runs_db`. The `locks_dir` key is
silently ignored when set in the per-repo file — locks are machine state, not
repo state. The per-repo file is still type-checked for `locks_dir` (a
non-string value surfaces a parse error), but the value is never applied.

Source: `src/worktree/config.ts` — `loadWorktreeConfig()`

## Environment variables

### `MINIFAC_HOME`

Overrides the machine-wide state root. Every path that would otherwise resolve
relative to `~/.minifac/` is resolved relative to this directory instead.

- Default: `~/.minifac`
- When to set: CI pipelines or test environments that need to isolate minifac
  state from the real `~/.minifac/` on the same machine.

`MINIFAC_HOME` controls where minifac looks for the machine-wide `config.yaml`,
the default `worktrees/` directory, the default `locks/` directory, and the
default `runs.db` path — anything derived from `minifacHome()`.

Source: `src/worktree/config.ts` — `minifacHome()`

No other `MINIFAC_*` environment variables are read by minifac itself at
runtime. (`MINIFAC_STATUS` is a protocol token the Claude executor parses
from model output — it is not an environment variable minifac reads from the
process environment.)

## File format

Both config files are **YAML**. The document must be a mapping at the top
level; a non-mapping document (e.g. a bare string or a sequence) is a parse
error. All keys are snake_case.

Relative paths in config values are resolved against the directory containing
the config file that set them, not against the repo root or cwd.

The parser is the [`yaml`](https://www.npmjs.com/package/yaml) npm package
(`parseDocument` with `prettyErrors: true`). Parse errors include the
offending file path and line/column position in the error message.

Source: `src/worktree/config.ts` — `readMaybeYaml()`

## Config keys

### Worktree settings

#### `worktrees_dir`

| | |
|---|---|
| Type | `string` (non-empty) |
| Default | `${MINIFAC_HOME}/worktrees` |
| Overridable per-repo | yes |

Absolute path to the directory where minifac creates git worktrees for each
run. Relative paths are resolved against the config file's directory.

Set this when you want worktrees on a different volume (e.g. a faster SSD) or
outside your home directory.

Source: `src/worktree/config.ts` — read in `loadWorktreeConfig()`; used in
`src/worktree/paths.ts` — `worktreePathForKey()`, `runWorktreePathForDir()`

See also: [[Worktree]]

#### `default_branch`

| | |
|---|---|
| Type | `string` (non-empty) |
| Default | none (undefined) |
| Overridable per-repo | yes |

The default branch name used when pruning to determine whether a worktree's
branch has been merged. When not set, minifac infers the default branch from
the repo via `git symbolic-ref refs/remotes/origin/HEAD`.

Set this when your repo does not have a remote, or when the heuristic picks the
wrong branch.

Source: `src/worktree/config.ts` — read in `loadWorktreeConfig()`; consumed by
`src/worktree/prune.ts` — `pruneWorktrees()`

#### `locks_dir`

| | |
|---|---|
| Type | `string` (non-empty) |
| Default | `${MINIFAC_HOME}/locks` |
| Overridable per-repo | **no** (value from per-repo file is validated but ignored) |

Absolute path to the directory where per-change lockfiles are written. Relative
paths are resolved against the config file's directory.

Lockfiles serialise concurrent `minifac run` invocations for the same
change-name + factory combination. Stale locks (dead PID) are reclaimed
automatically. Because lock state is machine-local, this key is intentionally
machine-wide only.

Source: `src/worktree/config.ts` — read in `loadWorktreeConfig()`; used in
`src/worktree/paths.ts` — `lockPathForKey()`

See also: [[Worktree]]

### Runs DB settings

#### `runs_db`

| | |
|---|---|
| Type | `string` (non-empty) |
| Default | `${MINIFAC_HOME}/runs.db` |
| Overridable per-repo | yes |

Absolute or relative path to the SQLite database that stores run history.
Relative paths are resolved against the directory of the config file that
set the value — so `./local.db` in a per-repo config resolves to
`<repo-root>/.minifac/local.db`.

Set this when you want each repo to have its own isolated run history, or when
you want to place the database on a different filesystem.

Source: `src/worktree/config.ts` — read in `loadWorktreeConfig()`; consumed by
`src/storage/open.ts` — `openDefaultRunStore()`

See also: [[Runs-DB]]

## Example config files

### Minimal machine-wide config (`~/.minifac/config.yaml`)

```yaml
# Redirect worktrees to a faster volume
worktrees_dir: /Volumes/fast/minifac/worktrees

# Default branch for repos without a configured remote HEAD
default_branch: main
```

### Per-repo config (`.minifac/config.yaml`)

```yaml
# Keep this repo's run history separate from the global database
runs_db: ./runs.db

# Use a different base branch for this repo
default_branch: develop
```

### Overriding worktrees per-repo

```yaml
# Store worktrees alongside this repo (not under ~/.minifac)
worktrees_dir: /absolute/path/to/worktrees
```

## Full merge example

Given these two files:

```yaml
# ~/.minifac/config.yaml
worktrees_dir: /fast/worktrees
locks_dir: /fast/locks
default_branch: main
runs_db: /fast/runs.db
```

```yaml
# <repo>/.minifac/config.yaml
worktrees_dir: /repo-specific/worktrees
default_branch: develop
runs_db: ./local.db
locks_dir: /ignored/locks   # parsed but not applied
```

The resolved config is:

| Key | Value | Source |
|---|---|---|
| `worktreesDir` | `/repo-specific/worktrees` | per-repo wins |
| `locksDir` | `/fast/locks` | machine-wide (per-repo ignored) |
| `defaultBranch` | `develop` | per-repo wins |
| `runsDb` | `<repo>/.minifac/local.db` | per-repo wins (relative resolved) |

## Loader location

`src/worktree/config.ts`

- `minifacHome()` — resolves `MINIFAC_HOME` or falls back to `~/.minifac`
- `loadWorktreeConfig(callerRepoRoot)` — reads and merges both config files,
  returns a `WorktreeConfig` object with camelCase keys

The `WorktreeConfig` interface (same file):

```typescript
interface WorktreeConfig {
  worktreesDir: string;
  locksDir: string;
  defaultBranch?: string;
  runsDb: string;
}
```

## Related

- [[Worktree]] — describes where worktrees live and the lock mechanism
- [[Runs-DB]] — describes the SQLite run history store
- [[0009-Worktree-Default]] — rationale for worktree-mode default and the
  machine-local state layout
- [[0011-SQLite-for-Runs]] — rationale for SQLite as the runs store
- [[0012-Where-State-Lives]] — decision on what lives in `~/.minifac/` vs. the repo
