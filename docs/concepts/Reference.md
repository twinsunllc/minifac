---
tags: [concept, direction]
aliases: [reference, uses-reference, extends-reference, step-reference]
---

# Reference

A **reference** is the string a factory uses to point at
something defined elsewhere. Two surfaces:

- `extends: <reference>` in a factory file — points at a
  parent factory
- `uses: <reference>` on a node — points at a reusable
  [[Step]]

References are the share-and-compose primitive of minifac.
This doc covers what references look like today, where they
resolve, and the direction we expect the resolver to grow.

## Grammar (current)

Three reference forms are recognized:

| Form | Example | Status |
|---|---|---|
| `minifac:<name>[@<version>]` | `minifac:openspec-propose` | Implemented — bundled built-ins |
| `<name>[@<version>]` | `lint-check` | Implemented — user-local |
| `<scope>/<name>[@<version>]` | `myorg/lint-check` | **Reserved.** Parses; rejected at resolution time pending a future remote-resolution brief |

The `@<version>` pin is parsed and validated but not yet
used for resolution. It's present so future versions can pin
without breaking the grammar.

## Resolution (current)

For `minifac:<name>` references, the resolver chain is:

1. **Bundled built-ins** — `<package-root>/examples/steps/<name>.yaml`
   or `<package-root>/examples/<name>.yaml` (factories).
   `<package-root>` is computed from `import.meta.url`.
2. **Source-tree fallback** — `<callerCwd>/examples/...`. Used
   when minifac is run from its own source tree
   (`callerCwd === <package-root>` in that case anyway).

For bare `<name>` references:

1. **User-local** — `<callerCwd>/.minifac/steps/<name>.yaml`
   or `<callerCwd>/.minifac/factories/<name>.yaml`.
2. **Built-in fallback** — same as `minifac:<name>` above.

For `<scope>/<name>` references: rejected with an error
pointing at this document.

See [[0030-Bundle-Builtins]] for the binding decision on
built-in shipping and resolver behavior.

## Direction (where we expect this to go)

The current resolver chain handles bundled + user-local. The
likely growth direction adds two more layers:

### Layer 3: Remote, cached

Once people start wanting to share workflows across repos
(especially within an org), the resolver gains a
**cached-remote** layer:

```
1. Bundled built-ins        (minifac:*)
2. User-local files         (.minifac/{steps,factories}/*)
3. Already-fetched remotes  (~/.minifac/cache/refs/...)   ← NEW
4. Fetch fresh from remote  (git clone / git fetch)       ← NEW
```

Remote references would use either a fully-qualified git URL
or a forge shorthand:

```
uses: github.com/myorg/lint-check@v1.2.0
uses: github.com/myorg/lint-check@a3f7c9b   # SHA-pinned
uses: git+ssh://gitlab.example.com/team/factories@main
```

The shorthand `<host>/<org>/<repo>[/<path>]@<ref>` maps to a
git URL; the resolver clones (shallow, depth=1) to
`~/.minifac/cache/refs/<host>/<org>/<repo>/<ref>/` and reads
`step.yaml` / `factory.yaml` from the indicated path (or
repo root by default).

### Layer 4 (deferred indefinitely): Marketplace

A public-discovery surface — "search for steps that do X" —
is interesting but **not** load-bearing. Federated git URLs
give you most of the value (anyone can publish; URLs are
trustless and shareable). Discovery problems are usually
solved by `awesome-<thing>` README lists or
search-engine indexability rather than a custom marketplace.

We deliberately don't commit to building a marketplace. If
one ever exists, it could sit on top of layer 3 as a curated
URL catalog.

## Use cases driving the eventual resolver

### Org-internal sharing (most pressing)

A team has a custom factory or step they want to reuse
across all their repos. Today they'd copy YAMLs into each
repo's `.minifac/`. Maintenance pain scales with repo count.

With layer 3 — `uses: github.com/myorg/lint-check@v1.2.0` —
the team publishes once, references everywhere, version-pins
deliberately. Private repos work the same way; the system's
git credentials handle auth (no new minifac-specific auth).

### Cross-org public sharing

A great `terraform-plan-summary` step or a `migration-helper`
factory written by community member X. Without layer 3, X
has to publish a blog post and people copy-paste. With layer
3, X publishes to a git repo, others reference it directly.

### Forking a built-in

Someone wants a slightly different version of the bundled
`sdd` factory than what minifac ships. With layer 3 they can
fork the spec into their own repo and reference the fork
directly without affecting other users of `minifac:sdd`.

## Discipline we expect to inherit

Public OSS supply-chain experience (especially with GitHub
Actions) gives us guardrails to bake in from the start of
layer 3:

- **SHA-pinning encouraged.** Tag refs (`@v1`) are mutable.
  An eventual `minifac refs pin` command would auto-pin SHAs
  the same way `pinact` does for GitHub Actions. See
  [[0024-CI-Security-Policy]] for the analogous policy on
  actions.
- **Branch references discouraged.** `@main` resolves but
  surfaces a warning ("this reference is mutable and not
  reproducible").
- **Loud failure on unverified-publisher remotes.** Future
  feature: maintain an allowlist of trusted hosts /
  organizations; references outside it require an explicit
  opt-in.

## Auth model (when remote arrives)

Use the host's existing git auth. SSH keys, HTTPS tokens
(`gh auth login`, `git credential.helper`), enterprise GitHub
PAT — whatever already works for `git clone`. No minifac-
specific credential store.

Private references "just work" if the user can `git clone`
the underlying URL. Failures (auth, network) surface as clear
errors with the actual `git` exit status and stderr.

## Caching and offline behavior

Once layer 3 is in place:

- First reference to a remote URL: fetches and caches under
  `~/.minifac/cache/refs/`.
- Subsequent references: served from cache, no network call.
- `minifac refs refresh [pattern]` re-fetches cached refs.
- `minifac refs prune` reclaims cache space.
- Offline behavior: cached refs continue to work.
  Un-cached references fail with a clear "not in cache,
  cannot fetch offline" error.

## Versioning expectations

Steps and factories already carry a `version:` field per the
[[Step]] schema. For shared references, the convention will
be:

- Tag-based: `<repo>@v1.2.0` resolves to the git tag
- Branch-based: `<repo>@main` (warned; mutable)
- SHA-pinned: `<repo>@a3f7c9b...` (full integrity)

Semver-style range resolution (`@^1`) is unlikely to ship —
the SHA-pinning discipline preferred for security obviates
range matching. References should be either pinned or
explicitly mutable; ranges are the worst of both.

## Named triggers (when each layer ships)

| Layer | Trigger to brief | Likely brief title |
|---|---|---|
| 3 — cached remote | When the first user (Twin Sun internal counts) needs to share a step across multiple repos | `remote-references` |
| 4 — marketplace | Genuine community contribution volume + Twin Sun bandwidth to curate. Possibly never. | `references-marketplace` (speculative) |

## Not in scope (forever, probably)

- **NPM as the transport for steps/factories.** npm packages
  are a different mental model (deps with transitive deps,
  postinstall scripts, lockfiles). The git-URL model is
  simpler and matches GitHub Actions' choice for the same
  reason.
- **Per-step lockfiles.** A factory's references could
  pin via SHA + the lockfile is the YAML itself.
- **Plugin systems that aren't just references.** A factory
  is a YAML file; a step is a YAML file. The reference
  resolver is the only plugin surface.

## Related

- [[0030-Bundle-Builtins]] — the immediate decision: built-ins
  ship with the package
- [[Step]] — the unit references point at (`uses:`)
- [[Factory]] — the unit `extends:` points at
- [[0024-CI-Security-Policy]] — analogous SHA-pinning
  discipline already applied to GitHub Actions
- [[Open-Questions]] — the "when do we build remote
  resolution" question lives there with this doc as the
  reference
