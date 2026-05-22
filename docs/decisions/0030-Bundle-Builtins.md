---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0030: Bundle built-in factories and steps with the package

## Context

The bundled SDD factory and its `minifac:openspec-*` steps
don't actually ship with the npm-installed package today.
Two compounding issues:

1. `package.json`'s `files:` array excludes `examples/`. Only
   `dist`, `README.md`, `LICENSE`, and `CHANGELOG.md` make it
   into the tarball.
2. The reference resolver (`src/step/resolve.ts:144`,
   `src/factory/extends.ts:19`) hardcodes lookups relative to
   `callerCwd` — the user's current directory. Even if
   `examples/` shipped in the tarball, the resolver wouldn't
   look in `node_modules/minifac/examples/`.

Smoke test from a clean tmp directory confirms:

```
$ cd /tmp/fresh && node .../dist/cli.js run sdd
Could not resolve `sdd` as a brief path, brief name
(/tmp/fresh/inputs/sdd.md), or factory name
(/tmp/fresh/.minifac/factories/sdd.yaml,
 /tmp/fresh/examples/sdd.yaml)
```

This contradicts the README's pitch (`npx minifac init
--with-sdd && npx minifac run <brief>`) and the
[[Factory]] / [[Step]] schema docs that reference
`minifac:sdd` and `minifac:openspec-*` as valid references.
The `minifac init --with-sdd` command itself writes
`.minifac/factories/sdd.yaml` containing
`extends: "minifac:sdd"` — a reference that never resolves.

The OSS launch story can't ship until this is fixed. This
ADR pins the immediate fix; the broader future-direction for
resolution is sketched in [[Reference]].

## Decision

Bundle the canonical built-in factories and steps with the
npm package, and teach the resolver to find them in the
installed package directory.

### 1. What ships in the tarball

Add `examples` to `package.json#files`. The published tarball
will contain:

```
examples/
├── hello.yaml
├── sdd.yaml
├── sdd.md
├── sample-brief.md
└── steps/
    ├── openspec-propose.yaml
    ├── openspec-apply.yaml
    ├── openspec-verify.yaml
    └── openspec-archive.yaml
```

Plus any future built-ins added under the same path. The
shape stays YAML-on-disk — no compile step into JS bundles
(keeps the source-of-truth in human-readable files; debug-
ability wins over marginal startup savings).

### 2. Resolver finds the install directory

`minifac:<name>` references resolve against the **installed
package directory**, computed once at startup via
`fileURLToPath(import.meta.url)` rooted to the package
boundary (the directory containing `package.json`).

Lookup order for `minifac:<name>`:

1. **Bundled built-ins** at `<package-root>/examples/{steps,}/<name>.yaml`
2. **Source-tree fallback** at `<callerCwd>/examples/{steps,}/<name>.yaml`
   — keeps `minifac` runnable from its own source tree, where
   `callerCwd` is the project root and `<package-root>/examples/`
   *is* the source-tree `examples/`.

In practice these often coincide — but the explicit two-step
lookup makes the contract clear: `minifac:*` is "the
built-in shipped with this runner's release", regardless of
whether you're an installed user or a contributor.

Bare references (`<name>`) and namespaced references
(`<scope>/<name>`) continue to resolve under `<callerCwd>/.minifac/`
as today. They are **user-local**, not built-in.

### 3. Built-ins are version-locked to the runner

A consequence of the bundled approach: updating a built-in
step (`openspec-propose`, etc.) requires releasing a new
minifac version. This is the same model Node uses for its
stdlib — `fs` ships with Node; you don't `npm install fs`.

Built-ins are minifac's **stdlib**. Anything that needs to
ship outside the package release cadence is a user-local or
(future) remote reference — see [[Reference]].

### 4. Reference grammar leaves room for future schemes

The current grammar (per [[Step]] schema doc) accepts:

- `minifac:<name>[@<version>]`
- `<scope>/<name>[@<version>]`
- `<name>[@<version>]`

This ADR's scope:
- `minifac:<name>` resolves to bundled built-ins ✅
- `<name>` resolves to local files ✅
- `<scope>/<name>` continues to be **parsed but reserved** —
  the loader recognizes the form but rejects it at resolution
  time with a clear error pointing at [[Reference]]'s future-
  direction notes. We don't silently accept it as if it works.

This leaves the door open for `<scope>/<name>` to mean
"fetched from a remote source" in a future brief — without
re-litigating the grammar.

## Consequences

- `npx minifac` users can actually run the bundled SDD
  factory. The OSS install pitch is no longer aspirational.
- `minifac init --with-sdd` works end-to-end on a fresh
  install.
- Built-ins ship and update on the package release cadence.
  Critical for keeping the canonical SDD factory in sync with
  any breaking schema changes.
- Tarball grows slightly (the four step files + two factory
  files + their doc). Well under 100 KB.
- Source-tree dogfood still works — running from
  `~/projects/minifac` resolves `minifac:*` references via
  the source-tree fallback.
- The reference grammar is now explicit about what's
  supported. `<scope>/<name>` failing loudly is better than
  silently passing through to a bare-name lookup that
  happens to fail.

## Alternatives considered

- **Compile YAMLs into JS modules under `dist/builtins/`.**
  Rejected — the YAMLs stay human-readable and editable in
  source. Marginal startup cost of reading a YAML file is
  invisible. Compiling them obscures debuggability for no
  meaningful gain.
- **Embed built-ins as string literals in TypeScript source.**
  Same problem as above, plus less navigable.
- **Stop shipping built-ins; tell users to copy `examples/`
  manually.** Rejected — defeats the entire "batteries
  included" pitch. The README would have to say "first,
  clone our repo to copy these YAMLs" which is a terrible
  first impression.
- **Full registry-style remote resolution from day one.**
  Deferred — see [[Reference]] for the eventual direction.
  Premature for v0.1; the bundled approach is what most
  installed users need anyway. Registry-style support is the
  *next* layer on the resolver chain, not its replacement.
- **`<scope>/<name>` quietly falls back to bare lookup.**
  Rejected — silent surprises are worse than loud rejection.
  Future-reserved syntax should fail with a "not yet
  implemented" error, not surprise success.

## Open questions

- Whether `package.json#files` should include the entire
  `examples/` tree (including `sdd.md` and `sample-brief.md`)
  or just the YAML files. Leaning toward whole tree — the
  doc files are useful reference for users who want to
  understand the bundled factory. Negligible bytes either way.
- Whether to add a `minifac steps --bundled` shortcut for
  listing bundled built-ins separately from local steps.
  Probably yes, fold into the `bundle-builtins` brief if
  cheap.

## Related

- [[Reference]] — concept doc covering current resolution
  rules and the eventual resolver chain
- [[Step]] / [[Factory]] — schema docs that document
  `minifac:` references; will get a brief amendment noting
  that built-ins ship with the package
- `inputs/bundle-builtins.md` — the implementation brief
- [[Open-Questions]] — gains a discoverability question
  pointing at [[Reference]]
