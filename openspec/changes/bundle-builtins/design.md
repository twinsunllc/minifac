## Context

`minifac:<name>` references currently resolve against `<callerCwd>` —
the directory the CLI was invoked from. That works while developing
inside the minifac source tree (where `callerCwd` and the package root
coincide) but breaks for installed users: their `callerCwd` has no
`examples/` directory, and the package's `examples/` is buried under
`node_modules/minifac/`.

Three resolvers share the `minifac:<name>` semantics:

- `src/step/resolve.ts` — for node `uses: minifac:<step-name>`.
- `src/factory/extends.ts` — for top-level `extends: minifac:<factory-name>`.
- `src/cli/resolve.ts` — for `--factory minifac:<name>` and brief
  `factory: minifac:<name>`.

All three currently resolve against `<callerCwd>/examples/…`. The fix
is a shared install-root utility plus a uniform install-first / source-
tree-fallback lookup in each resolver.

A secondary cleanup: the `<scope>/<name>` reference form is in the
grammar but its resolution is currently soft — for `resolveStepRef` it
parses scope into the result and continues with the local-first
lookup, which silently degrades to a bare-name miss. We want the form
to be **reserved-but-rejected** so future remote-resolution work can
activate it without re-litigating the grammar.

## Goals / Non-Goals

**Goals:**

- `minifac:<name>` references resolve correctly when minifac is
  installed via npm (the tarball ships `examples/` and the resolver
  finds it under the package root).
- Source-tree dogfood still works (running `node dist/cli.js` from a
  clone resolves `minifac:*` against the local `examples/`).
- `<scope>/<name>` references fail loudly with a message pointing at
  the future-direction doc, so we don't paint ourselves into a corner.
- `minifac steps --source built-in` surfaces bundled steps for an
  installed user without requiring them to know where the tarball is
  unpacked.

**Non-Goals:**

- Remote resolution (`github.com/<org>/<repo>@<ref>` etc.) — see
  `docs/concepts/Reference.md` § Direction.
- Marketplace / discovery UX.
- Compiling YAMLs into JS modules.
- Versioned built-ins side-by-side.
- An installed-package fallback for **bare** (`<name>`) references —
  bare names stay user-local-only by design.
- `minifac refs pin` / `minifac refs refresh` CLI surface.

## Decisions

### D1. Ship `examples/` as YAML in the tarball

Add `examples` to `package.json#files`. No compile step; YAMLs ship
human-readable.

**Why over the alternatives:**

- Compile-to-JS modules under `dist/builtins/` — rejected. Marginal
  startup savings, real loss of debuggability and navigability. The
  user can `cat node_modules/minifac/examples/sdd.yaml` to see what
  they're getting.
- Inline as string literals in TypeScript — same drawbacks as compile,
  plus harder to diff across releases.
- Don't ship built-ins; tell users to copy from the repo — defeats the
  "batteries included" pitch entirely.

Tarball size impact is negligible (well under 100 KB for the current
set).

### D2. Compute the install root once, from `import.meta.url`

```ts
// src/packaging/install-root.ts
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let cached: string | null = null;

export function installRoot(): string {
  if (cached !== null) return cached;
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Compiled file lives at <pkg-root>/dist/packaging/install-root.js,
  // so walking up two directories gets the package root.
  cached = resolve(here, "..", "..");
  return cached;
}
```

The resolver layout is `dist/packaging/install-root.js` (TypeScript
source under `src/packaging/install-root.ts` is transpiled with the
same directory shape). The `../..` step lands at the package root —
the directory that contains `package.json`. A test verifies that
contract by reading `package.json` from the returned path and asserting
`name === "minifac"`.

**Why this over alternatives:**

- `require.resolve("minifac/package.json")` — works under CommonJS but
  not cleanly under the ESM-only setup we have (`"type": "module"`).
- Walking up looking for `package.json` — more flexible but adds I/O on
  every cold start; the fixed-offset approach is deterministic and
  cheaper.
- `process.argv[1]` — fragile when the binary is invoked via a
  symlinked shim (which is exactly what `npx` does).

The fixed-offset approach is correct as long as the source layout
under `dist/` matches the source layout under `src/`. The build script
(`tsc`) preserves the directory shape; if it ever changes (e.g.
bundling to a single file), the helper updates with it.

### D3. Two-step lookup: install-root first, source-tree fallback

All three resolvers apply the same precedence for `minifac:<name>`:

```
1. <install-root>/examples/[steps/]<name>.yaml   (installed package)
2. <callerCwd>/examples/[steps/]<name>.yaml      (source-tree dogfood)
```

When running from a clone, the two paths collapse to the same file —
no behavioral difference. When running from an `npx`-installed
tarball, only path #1 exists. When a future user (somehow) runs against
an in-development minifac checked out outside the install root, the
source-tree fallback keeps them unblocked.

**Why install-root first:**

The install-root path is the contract: `minifac:<name>` resolves to
"whatever the runner shipped." Source-tree fallback is a convenience
for contributors. If a contributor has a stale `examples/sdd.yaml` in
their checkout but is running an installed minifac, we want the
installed version to win — keeping the runner's behavior and its
stdlib version-locked together (D5 below).

Error message on a miss names both paths in order, matching the existing
`StepLoadError` / `FactoryLoadError` style.

### D4. Reject `<scope>/<name>` at resolution time

`parseStepRef` already extracts `scope` into `ParsedStepRef`. Today
`resolveStepRef` ignores the scope and falls through to the bare-name
two-step lookup. We change that to throw `StepLoadError` whose message
is:

> Step reference `<scope>/<name>` uses the scoped form
> (`<scope>/<name>`), which is reserved for future remote resolution
> and not yet supported. See docs/concepts/Reference.md for the planned
> semantics.

Same treatment in `resolveExtendsRef` if it ever sees the scoped form
(today the grammar in `extends.ts` doesn't accept a slash, so this is a
"belt and suspenders" guard; the spec scenarios capture the contract
either way).

**Why loud rejection:**

If a user types `myorg/sdd` and we silently fall through to a bare-
name lookup, they get a confusing "could not resolve `myorg/sdd` —
tried `.minifac/steps/myorg/sdd.yaml`" message. Loud rejection tells
them "this form is reserved; use one of the supported forms" and points
at the concept doc. The cost is one rejected scenario today; the
benefit is no migration burden when we activate remote resolution.

### D5. Built-ins are version-locked to the runner

Implicit consequence of D1: bumping a built-in step requires shipping a
new minifac version. This matches the Node stdlib model (you don't
`npm install fs`) and keeps the canonical SDD factory in sync with any
breaking schema changes. Out-of-band updates would require remote
resolution (deferred to [[Reference]]).

This is non-load-bearing for the implementation — no code enforces
it — but it shapes how we describe `minifac:*` in docs ("the stdlib
that ships with this runner").

### D6. `minifac steps --source built-in` reads the install root

The existing flag accepts `local | built-in | all`. Today `built-in`
means "files under `<cwd>/examples/steps/`." We update the underlying
scan to read the install root's `examples/steps/` instead — falling
back to `<cwd>/examples/steps/` only when the install root doesn't
exist (which doesn't happen in any practical scenario but mirrors the
resolver semantics for consistency).

`local` continues to mean `<cwd>/.minifac/steps/`. `all` is the union.
When a local file shadows a bundled built-in with the same name, both
rows appear under `all` (existing behavior); the operator
disambiguates by the `source` column.

## Risks / Trade-offs

- **Build-output layout coupling.** `installRoot()` assumes the
  compiled file lives at `<pkg-root>/dist/packaging/install-root.js`.
  → Covered by a unit test that reads `package.json` from the returned
  path and asserts `name === "minifac"`. If the build ever bundles to a
  single file, the test fails loudly and we update the helper.
- **Source-tree fallback masking a real miss.** When a contributor
  deletes a built-in YAML by accident, the install-root path won't
  exist but the source-tree path will — they wouldn't notice the bug
  until release. → Mitigation: the smoke test (step 6 in the brief)
  exercises the install path against a packed tarball, so any missing
  bundled file fails CI.
- **`<scope>/<name>` rejection breaks any factory currently using the
  form.** → The grammar accepts the form but no shipped factory uses
  it. Risk is theoretical; if we find user factories using it, the
  error message tells them exactly what to switch to.
- **Tarball bloat creep.** As we add more built-ins, `examples/` grows.
  → Acceptable; the SDD-focused set is small. A future "trim" can move
  rarely-used examples elsewhere if/when it matters.

## Migration Plan

No migration needed for users running from source — their behavior
doesn't change. Users on an installed tarball see broken
`minifac init --with-sdd && minifac run …` flows start working
silently on upgrade. No deprecations.

Rollback: revert the four implementation commits (tarball, resolver,
extends, factory-by-name) and the spec change. No persisted state is
touched.

## Open Questions

- Whether to also ship `examples/sample-brief.md` and `examples/sdd.md`
  alongside the YAMLs. Leaning yes (negligible bytes, useful reference
  for users who want to understand the bundled factory). Captured in
  ADR 0030 open questions; resolved as "yes, ship the whole tree" in
  this brief's acceptance criteria.
- Should `minifac steps` surface the install-root path in its
  `source: built-in` rows so the operator can find the file on disk?
  Probably yes via the existing `path` column in `--json`; no new flag
  needed.
