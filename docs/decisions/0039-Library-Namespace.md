---
status: accepted
date: 2026-09-15
supersedes: []
superseded-by: null
tags: [decision]
---

# 0039: `library:` namespace — one pinned library per project, fetched at an immutable ref

## Context

A factory repository (the `<client>-factory` shape in scarif-spec's
`factory-repo-contract`) wants to run a shared workflow from a
**library** repository, with its own overrides on top. The contract
fixes the resolution order — library at the pinned ref, then the
factory's own `workflows/` and `steps/`, then the node — with
whole-artifact replacement ([[0008-File-Per-Factory-Composition]]),
and it rules that the graph runner does the resolving.

minifac could not express any of it (issue #44, scarif-factory
FINDINGS F1):

- `uses:` resolved only from `<cwd>/.minifac/steps/` and built-ins;
  workflows only from `<cwd>/.minifac/factories/`. A factory repo's
  root `steps/` and `workflows/` were invisible.
- `extends:` took a bare name or `minifac:<name>` and rejected paths,
  so a factory's `standard_implementation` could not extend the
  library's `standard_implementation` — a bare `extends:` of the same
  name resolves to the file doing the extending.
- Nothing fetched a remote. [[Reference]] sketched cached-remote and
  fetch-fresh resolver layers but no code existed.

The first consumer (`twinsunllc/scarif-factory`) worked around this
with a full copy of the library workflow and a `bin/workspace` script
that cloned the library, checked the pin, and copied library and
factory files into `.minifac/`. The contract says that copy is to be
replaced by a no-override `extends: library:<name>` once the runner
has the namespace, and the script deleted.

## Decision

### Declaration: one library per project, pinned

A project declares at most one library:

```yaml
library:
  repo: twinsunllc/scarif-workflows   # owner/name (GitHub), a git URL, or an absolute path
  ref: v0.1.0                         # a tag or a full 40-character commit sha
```

in either `factory.yaml` at the project root (the factory-repo
manifest — the shape scarif-factory already carries) or
`.minifac/config.yaml`. Declaring it in both is a load error: two
sources of truth for one pin is how pins drift. `library` has exactly
the keys `repo` and `ref`; anything else is refused.

One pin per project, not a pin per reference. Per-reference pins
(`uses: github.com/org/lib/review@v1`, the form [[Reference]]
sketched) put the same version decision in N places, and N copies of
a pin drift — the failure the contract exists to prevent.

### The factory-repo layout

A project whose root carries `factory.yaml` is a **factory repo**:
its root `steps/` and `workflows/` join `.minifac/steps/` and
`.minifac/factories/` as the local layer. Without `factory.yaml`,
root `steps/` and `workflows/` mean nothing to minifac, so an
ordinary repository that happens to have a `steps/` directory is
unaffected.

### Resolution by reference form

| Reference | Candidates, in order |
|---|---|
| `uses: minifac:<name>` | built-in only (unchanged) |
| `uses: library:<name>` | local (`.minifac/steps/`, then root `steps/` in a factory repo), then the library's `steps/` |
| `uses: <name>` | local, then the library's `steps/`, then built-in (unchanged apart from the library layer) |
| `extends: minifac:<name>` | built-in only (unchanged) |
| `extends: library:<name>` | the library's `workflows/` **only** |
| `extends: <name>` | `.minifac/factories/`, then root `workflows/` in a factory repo, then the library's `workflows/` |
| factory by name (brief `factory:`, `minifac run <name>`, `--factory`) | `.minifac/factories/`, then root `workflows/` in a factory repo, then the library's `workflows/`, then `examples/` |

A library is laid out like a factory repo: `steps/<name>.yaml` and
`workflows/<name>.yaml` at its root. Nothing else in it is read.

Override is whole-artifact, per [[0008-File-Per-Factory-Composition]]:
a factory `steps/review.yaml` replaces the library's `review` step in
full; no field of the library step is merged in. A factory workflow
that `extends: library:<name>` and redeclares a node replaces that
node in full, and an override naming a node the base lacks is a load
error (issue #34, already shipped).

`library:` with no library declared, and a `library:` artifact the
library does not have, are load errors naming the namespace and the
pin (`no step \`nope\` in the library acme/lib@v0.1.0 (c8d531c…)`).

### Why `uses: library:` and `extends: library:` differ

They look inconsistent — one consults the local layer, the other
does not — and the difference is deliberate.

- **`extends: library:<name>` must skip local.** The whole point is a
  factory `workflows/standard_implementation.yaml` extending the
  library's `standard_implementation`. If the local layer were
  consulted, the base would resolve to the extending file itself.
  For workflows, the local override *is* the file that declares
  `extends:`; the `library:` reference names the layer beneath it.
- **`uses: library:<name>` must consult local.** A step has no
  `extends:`; its only override mechanism is a local file of the same
  name. If `library:<name>` skipped local, any library workflow that
  spelled its step references `library:review` (a natural thing for a
  library author to write) would be un-overridable, and a factory's
  `steps/review.yaml` would silently do nothing — the contract's layer
  2 would hold or not depending on spelling.

`minifac:<name>` keeps skipping local, as [[0030-Bundle-Builtins]]
fixed it: built-ins are the runner's stdlib, version-locked to the
release. A local override of a built-in is spelled with a bare name.

### The pin rule

`ref` must be an immutable pin: a tag name or a full 40-character
commit sha.

- Refused before touching the network: `HEAD`, `refs/...` spellings,
  revision expressions (`main~1`, `v1^{}`, `a..b`), and a leading `-`.
- Refused after fetching: a **branch** name (`library.ref: main names
  a branch … not an immutable pin`) and an **abbreviated sha**. These
  need the remote because a name alone does not say what it is — a
  tag may legally be called `c8d531c`, and a branch may be called
  `v1.0`. Tags win when a name is both.
- A branch is refused, not warned. [[Reference]] had proposed a
  warning; the consumer contract requires refusal, because a moving
  ref makes "which workflow ran" unanswerable after the fact.

**A tag resolves to its sha once.** The first resolution of a tag is
recorded in the cache (`tags.json`); if the tag later points
elsewhere the load fails naming both shas. A moved tag is exactly the
mutability the pin rule exists to exclude, and the only way to notice
it is to remember what the tag meant.

**A stale pin fails the load**, naming the pinned ref and the
library's current state: `library.ref: v0.1.0 is stale: no tag or
commit v0.1.0 in acme/lib. The library's current head: main at
<sha>; latest tag v0.2.0`. Stale means the tag no longer exists
remotely, or the pinned sha is no longer reachable from any remote
branch or tag. The contract's optional freshness policy (maximum pin
age, minimum library version) is not implemented; see Open questions.

### Fetch and cache (resolver layers 3 and 4)

Each library repo is mirrored once, bare, under
`$MINIFAC_HOME/cache/library/<slug>-<hash>/mirror.git`, keyed by the
repo URL. Each resolved sha is materialized once, content-addressed,
at `<slug>-<hash>/<sha>/` — the tree at that commit and nothing else
(no `.git`), written to a temporary directory and renamed into place
so a concurrent load never reads a half-written tree.

- **Cold cache (layer 4).** Clone the mirror. Failure is fatal and
  names the ref: `could not be fetched and nothing is cached`.
- **Warm cache (layer 3).** Refresh the mirror (`fetch --prune`,
  branches and tags) on every load, so a stale pin is caught. If the
  remote is unreachable, resolve from the mirror and emit a
  `MINIFAC_LIBRARY_OFFLINE` warning — a warm cache works offline.

This deviates from [[Reference]]'s layer-3 sketch ("subsequent
references: served from cache, no network call"). The contract
requires a stale pin to fail preflight, and staleness is a fact about
the remote; a cache that never asks cannot know. The network is
contacted on every load and tolerated when absent. Resolution is
memoized per process and per `(MINIFAC_HOME, repo, ref)`, so one
`minifac run` — which resolves the factory name and then loads it —
fetches once.

A mirror, not a shallow per-ref clone: stale-sha detection needs
reachability from the remote's refs, a moved tag needs the old
answer, and a library is a directory of YAML — the full history is
small.

Auth is the host's git auth (SSH keys, a credential helper, `gh auth
setup-git`), as [[Reference]] planned. `GIT_TERMINAL_PROMPT=0` keeps a
load from blocking on a password prompt. `owner/name` maps to
`https://github.com/owner/name.git`; `https://`, `ssh://`, `file://`,
`git@host:path`, and absolute paths pass through; other transports
(including `ext::`) are refused.

### Recording: runs.db schema v5

`runs` gains `library_repo`, `library_ref`, `library_sha`.
`loadFactory` returns the resolved pin as `LoadedFactory.library`, the
runner writes it on `createRun`, and `StoredRun.library` / `minifac
runs --json` surface it. The row records the pin **in effect** for
the load — the project's declared library — whether or not the
particular factory drew an artifact from it. "Which workflow ran" is
answered by the run's `factory_path` plus, when a library is in
effect, the sha every library artifact was read at.

## Consequences

- **The F1 workaround can go.** scarif-factory's
  `workflows/standard_implementation.yaml` becomes
  `extends: library:standard_implementation` and `bin/workspace` is
  deleted; `minifac run` works from the factory checkout directly.
- **A declared library is on the load path of every factory in the
  project**, including factories that use no library content. A bad
  pin fails them all. That is the fail-closed posture the contract
  asks for; the cost is that a project cannot keep working around a
  broken pin by avoiding library content.
- **Every load contacts the library remote.** Fast for a small
  mirror; tolerated offline. A long-running process (`autorun`,
  `serve`) resolves each pin once and does not notice a pin going
  stale until it restarts or the pin changes.
- **`runs.db` is a one-way door at v5**, the same contract as v4
  ([[0035-Cross-Node-Session-Resume]]): additive and forward-safe
  (pre-v5 rows read back with no library), but a binary older than
  the database refuses to open it.
- **The cache grows without bound.** One tree per resolved sha, one
  mirror per repo. Pruning is future work.
- **Factories with no library declaration are unaffected**: no
  fetch, no new lookup locations unless `factory.yaml` is present,
  and `minifac:` resolves exactly as before.

## Alternatives considered

- **Vendor the library into the factory** (the `bin/workspace`
  stopgap, or a `minifac vendor` command). Rejected — the contract
  measured copy-in to drift, and rules that the droid SHALL NOT vendor
  library files. A pin that fails loudly is the pattern that held.
- **Per-reference remote pins** (`uses: github.com/org/lib/x@v1`).
  Deferred, not rejected. They answer cross-org sharing, which the
  `<scope>/<name>` form still reserves room for. For one factory
  consuming one library they multiply the pin.
- **`uses: library:<name>` resolves the library only**, symmetric with
  `minifac:`. Rejected — see "Why `uses: library:` and `extends:
  library:` differ": it makes factory overrides depend on how the
  library spelled its step references.
- **Let a bare `extends: <name>` skip the declaring file** so
  `workflows/x.yaml` could say `extends: x` and reach the library's
  `x`. Rejected — too clever; the explicit namespace says what it
  means, and a bare self-reference stays the cycle error it is today.
- **Warn on a branch ref instead of refusing.** Rejected — the
  contract requires refusal.
- **Serve a warm cache without contacting the remote.** Rejected —
  it cannot detect a stale pin, which the contract requires.
- **Shallow clone per ref.** Rejected — cannot answer reachability or
  remember a tag's first sha.
- **A `--library` CLI flag.** Deferred — nothing needs to override a
  project's pin per invocation yet, and a per-invocation pin is a
  second source of truth.

## Open questions

- **Freshness policy.** The contract permits a factory to declare a
  maximum pin age or a minimum library version that preflight
  enforces. Not implemented; add when a factory declares one.
- **`minifac steps`** lists local and built-in steps; it does not list
  library steps or show which layer a bare name resolves to.
- **Cache management** (`minifac refs refresh` / `prune`, per
  [[Reference]]).
- **More than one library per project.** One is what the contract
  declares; a second library would need a name in the namespace
  (`library:<lib>/<name>`), which the grammar currently rejects.

## Related

- [[0008-File-Per-Factory-Composition]] — whole-artifact override
- [[0018-Reusable-Steps]] — `uses:` and the step lookup this extends
- [[0020-Factory-Override-At-Invocation]] — factory-by-name lookup
- [[0030-Bundle-Builtins]] — `minifac:` semantics, kept
- [[0035-Cross-Node-Session-Resume]] — the previous runs.db one-way door
- [[Reference]] — resolver layers 3–4, now implemented for libraries
- scarif-spec `factory-repo-contract` — "Resolution order" and "The
  library pin is explicit" requirements
