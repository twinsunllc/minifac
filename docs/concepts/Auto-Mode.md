---
tags: [concept]
aliases: [autorun, auto-mode, build-farm]
---

# Auto-Mode

Auto-mode is minifac's "build farm." A long-running `minifac autorun`
process polls the inputs directory, picks up ready [[Brief]]s, and runs
them against their factories — using the same primitive a manual
`minifac run` would. Drop briefs in `inputs/`, let autorun chew through
them.

The shape is pinned in
[`0016-Auto-Mode`](../decisions/0016-Auto-Mode.md). This note explains
what it does, how it decides, and how to use it.

## Polling model

Autorun runs a poll loop on a configurable interval (default 10 s):

1. Enumerate `*.md` files in `--watch <dir>` (default `./inputs`).
2. For each, compute the brief's state via
   `computeBriefState` (per [[Brief]]'s lifecycle and
   `0015-Brief-Deps-and-State`).
3. Schedule briefs that pass the *ready predicate* (below) up to the
   `--max-concurrent` cap.
4. Skip the rest, emitting a `skipped reason=<...>` event.
5. Sleep until the next poll, or until `fs.watch(<dir>)` fires (a
   best-effort wake-up; polling is the safety net).

The poll order is **oldest brief file mtime first**, with ties broken
lexicographically by `change` name. Filesystem enumeration order is
not assumed.

## Ready predicate

A brief is *ready* iff ALL of:

- Its `doneness` is `active` (file lives at `inputs/<change>.md`, not
  `inputs/done/`).
- Every entry in `depends_on` resolves to `doneness === "done"`.
- Its `activity` is `none` or `failed` (a `succeeded` most-recent run
  row excludes the brief; a `running` row triggers the orphan probe —
  see below).
- Autorun is not already running this `change` locally.
- The user-supplied `--filter` (if any) matches the `change`.

A blocked brief is logged with reason `blocked` every poll; it stays
in the candidate set until something changes. A succeeded brief
naturally drops out once the runner's mark-done post-step moves it to
`inputs/done/`.

## Orphan reconciliation

A `runs.db` row stuck at `status='running'` after a killed runner
(force-quit, SIGKILL, crash, terminal close) used to block a brief
forever. Autorun now probes the per-change lockfile under
`~/.minifac/locks/<repo-hash>-<change>-<factory>.lock` whenever it
would otherwise skip for a `running` row:

- **Lockfile missing OR PID dead** ⇒ orphan. Autorun flips the row to
  `status='failed'`, `reason='orphaned'`, populates `ended_at`, then
  evaluates the brief through the rest of the readiness chain on the
  same poll cycle.
- **Lockfile present and PID live** (or `EPERM` — the conservative
  branch) ⇒ a real run is in flight elsewhere (another autorun
  instance, a manual `minifac run`, the daemon). Autorun skips with
  reason `running-elsewhere` and leaves the row untouched.

The probe relies on the runner's exit-ordering invariant: the
terminal `runs.db` row write completes BEFORE the lockfile is
unlinked, so a graceful exit cannot produce the orphan signature
("lock missing + row=running"). See the `worktree-management`
capability for the spec.

## Concurrency

`--max-concurrent <n>` (default `1`) caps parallel in-flight runs.
Each concurrent run gets its own [[Worktree]] per
`0009-Worktree-Default`; the per-change-name lockfile prevents
same-change collisions even if a manual `minifac run` happens
externally. [[Runs-DB]] handles concurrent writers via SQLite WAL.

Briefs that would otherwise schedule but exceed the cap are skipped
with reason `concurrency` and re-evaluated on the next poll.

## Signal handling

- **First SIGINT/SIGTERM**: stop scheduling new runs, wait for
  in-flight runs to settle, exit `0`.
- **Second SIGINT/SIGTERM**: send SIGTERM to every tracked in-flight
  child executor, wait briefly, exit `2`.
- **`--force`**: behave as if every signal is the second — kill on
  first signal. The CI escape hatch.

## `--once` for CI

`minifac autorun --once` runs a single poll cycle, waits for all
scheduled runs to settle, and exits `0`. Drop a "process the backlog"
step into CI: replace a loop-of-`minifac-run` shell script with one
`minifac autorun --once --json` invocation.

## `--dry-run` for rehearsal

`minifac autorun --dry-run` runs one poll cycle, emits one
`dry-run-decision` event per candidate brief showing whether it
*would* be scheduled (and the skip reason if not), invokes no runs,
and exits `0`. Useful when adding a new brief and unsure whether its
deps will let it run, or when debugging why something is stuck.

## Filtering

`--filter <expr>` restricts the candidate set by `change` name (not
file path). Two flavors:

- `/<pattern>/<flags?>` — JavaScript regex literal.
- Any other non-empty string — glob with `*` (zero-or-more non-`/`)
  and `?` (one non-`/`). No `**`, no `{a,b}`.

Examples: `--filter "feat-*"`, `--filter "/^chore-/i"`.

## Logging

One log line per scheduling event. Default human format:

```
2026-05-21T18:00:01Z started foo runId=run_abcd1234
2026-05-21T18:00:01Z skipped bar reason=blocked detail=baz (active)
2026-05-21T18:00:42Z completed foo status=succeeded runId=run_abcd1234
```

`--json` emits one JSON object per line on stdout, with an explicit
`event` field. Useful for shipping autorun events to a log
aggregator or piping through `jq`.

## Output mode: TUI vs. raw

When `process.stdout.isTTY` is truthy, `minifac autorun` mounts an
interactive TUI by default: a brief-list pane on the left (one row
per brief with status glyph + change name), an embedded
[[Run-TUI]] surface on the right for whichever brief you drill into,
and a bordered header / hotkey bar. Hotkeys: `↑/↓` (or `j/k`) to
move selection, `Enter` to drill into a brief, `Esc` to come back,
`r` to switch to raw output for the rest of the autorun process,
`q` to quit (drains in-flight runs; a second `q` while draining
escalates).

In a non-TTY (pipe, redirect, CI), autorun falls back to raw line
output — today's behavior, byte-identical. `--raw` forces raw even
on a TTY (the escape hatch for scripts that prefer to grep stderr).
`--tui` forces the TUI even in a non-TTY (useful for tests). `--raw`
and `--tui` together is a usage error; `--tui` and `--json` together
is a usage error (the JSON output stream is a machine-readable
contract that cannot coexist with a mounted TUI).

`--json` on a TTY without `--tui` keeps emitting JSON on stdout (the
JSON contract wins; no TUI is mounted).

## Relationship to `minifac run`

Autorun and `minifac run` share the same *run primitive*: the function
that owns lockfile claim, worktree creation, runner invocation,
finalization, and journal appending. Autorun-scheduled runs are
indistinguishable from manual ones in [[Runs-DB]]: same schema, same
branch naming, same mark-done semantics.

The mental model: `minifac run foo` is autorun with a candidate set
of one. Autorun is "run the backlog as it becomes ready."

## Related

- [[Brief]] — what autorun consumes; lifecycle and `depends_on`
- [[Runs-DB]] — where autorun-scheduled runs land
- [[Worktree]] — per-run isolation makes concurrency safe
- [`0016-Auto-Mode`](../decisions/0016-Auto-Mode.md) — the decision
- [`0015-Brief-Deps-and-State`](../decisions/0015-Brief-Deps-and-State.md)
  — the ready predicate
- [`0009-Worktree-Default`](../decisions/0009-Worktree-Default.md) —
  the lockfile contract autorun relies on
