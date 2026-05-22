---
change: bundle-builtins
factory: sdd
base_branch: main
---

## Background

The bundled SDD factory and its `minifac:openspec-*` steps
don't actually ship with the npm-installed package. The
README's quickstart (`npx minifac init --with-sdd && npx
minifac run …`) is currently aspirational — running it from
a fresh `npx` install fails with "Could not resolve `sdd`."

Two compounding issues, both load-bearing for the OSS
launch:

1. `package.json#files` excludes `examples/`. The tarball
   contains only `dist`, `README.md`, `LICENSE`,
   `CHANGELOG.md`.
2. The reference resolver
   (`src/step/resolve.ts:144`,
   `src/factory/extends.ts:19`) hardcodes `callerCwd`. Even
   if `examples/` shipped in the tarball, `minifac:sdd`
   wouldn't look in `node_modules/minifac/examples/`.

The binding decision is at
`docs/decisions/0030-Bundle-Builtins.md`. Read it first.
Key calls already locked:

- Ship `examples/` in the tarball (no compile step; YAMLs
  stay human-readable).
- Resolver gains an installed-package-directory lookup for
  `minifac:*` references; source-tree fallback preserved.
- `<scope>/<name>` references **parse but reject at resolution**
  with a clear error pointing at [[Reference]]. Future remote-
  resolution work will activate this form.
- Built-ins are version-locked to the runner (no separate
  release cadence).

See [[Reference]] for the broader resolver direction this
brief is the first step toward.

## What to do

### 1. Ship `examples/` in the tarball

In `package.json#files`, add `examples`:

```json
"files": ["dist", "examples", "README.md", "LICENSE", "CHANGELOG.md"]
```

Run `npm pack --dry-run` to verify the new tarball contents.
Confirm `examples/sdd.yaml`, `examples/hello.yaml`,
`examples/steps/openspec-*.yaml`, `examples/sdd.md`,
`examples/sample-brief.md` all appear.

### 2. Compute the installed package root

Add a small utility (`src/packaging/install-root.ts` or
similar) that resolves the installed package's root directory
from `import.meta.url`:

```typescript
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function installRoot(): string {
  // dist/packaging/install-root.js → resolve back to the
  // package root containing package.json
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "../..");
}
```

Confirm by reading `package.json` from the returned path and
checking `name === "minifac"`. (Cache the result; it's stable
for the lifetime of the process.)

### 3. Update `resolveStepRef` for `minifac:` prefix

In `src/step/resolve.ts`, when `parsed.builtinForced === true`:

```typescript
const installPath = resolve(installRoot(), "examples", "steps", `${parsed.name}.yaml`);
const fallbackPath = resolve(callerCwd, "examples", "steps", `${parsed.name}.yaml`);

if (await fileExists(installPath)) return installPath;
if (await fileExists(fallbackPath)) return fallbackPath;
throw new StepLoadError(
  `Could not resolve step reference \`${ref}\` — tried ${installPath}, ${fallbackPath}`,
  "(reference)",
);
```

Note: when running from the source tree the two paths
collapse to the same file, which is fine.

### 4. Update `resolveExtendsRef` for `minifac:` prefix

`src/factory/extends.ts` has the same shape. Mirror the
two-step lookup for factory `extends: minifac:<name>`
references.

### 5. Reject `<scope>/<name>` at resolution time

In `src/step/resolve.ts`, when `parsed.scope` is set and not
`builtinForced`:

```typescript
throw new StepLoadError(
  `Step reference \`${ref}\` uses the scoped form (\`<scope>/<name>\`), ` +
    `which is reserved for future remote resolution and not yet supported. ` +
    `See docs/concepts/Reference.md for the planned semantics.`,
  "(reference)",
);
```

Same change for `resolveExtendsRef` in
`src/factory/extends.ts` if it accepts scoped forms.

### 6. Smoke test from a clean tmp directory

Add an integration test (gated behind an env var or marked
slow) that:

1. Runs `npm pack` in the project root, getting a tarball
   path
2. In a clean `/tmp/<random>` directory:
   - `npm init -y`
   - `npm install <path-to-tarball>`
   - Runs `npx minifac init --with-sdd`
   - Writes a minimal brief at `inputs/smoke-test.md`
   - Runs `npx minifac run smoke-test --dry-run` (or some
     equivalent that doesn't actually dispatch to Claude)
3. Asserts that the factory loads and the resolver finds
   `minifac:sdd` and each `minifac:openspec-*` step

The test can stop short of actually dispatching Claude — the
goal is to prove the resolver succeeds against an installed
package. Use `runFactory`'s plumbing with a mock executor
registry to avoid spending tokens.

### 7. Update `minifac steps` to surface bundled separately

`minifac steps` currently lists local + built-in. The
`--source` filter already accepts `local` / `built-in` /
`all`. Verify it correctly shows the bundled steps from the
installed package directory after this change. No new flag
needed if the existing one Just Works.

### 8. Documentation

- Update [[Step]] and [[Factory]] schema docs to note that
  `minifac:*` references resolve against the installed
  package's built-ins.
- Add [[Reference]] (created alongside this brief) to the
  Reading Order in `docs/README.md`.
- Verify the README's quickstart now actually works
  end-to-end against a packed tarball.

### 9. CLI reference update

`docs/CLI.md` already mentions `init --with-sdd`. Confirm
the wording is honest post-fix (it should now actually
produce a runnable factory). Update if needed.

### 10. Tests

- Unit tests for the new `installRoot()` helper.
- Resolver tests covering: `minifac:` found in install dir;
  `minifac:` found in source-tree fallback; `minifac:` not
  found in either (clear error); `<scope>/<name>` rejected
  with the documented error.
- Schema validation tests stay green.
- The smoke test from step 6 (gated).

## Out of scope

- Remote resolution (`github.com/<org>/<repo>@<ref>`) — see
  [[Reference]] § Direction.
- Marketplace / discovery.
- Compiling YAMLs into JS modules.
- `minifac refs pin` / `minifac refs refresh` CLI commands.
- Versioned built-ins (multiple versions of `minifac:sdd`
  side by side).
- An installed-package-root lookup for **bare** (`<name>`)
  references — bare references stay user-local-only.

## Acceptance criteria

- `package.json#files` includes `examples`; `npm pack
  --dry-run` shows `examples/sdd.yaml`, `examples/hello.yaml`,
  every `examples/steps/openspec-*.yaml`, and the docs.
- `minifac:<name>` resolves against the installed package
  root first; falls back to `callerCwd/examples/...`.
- From a clean tmp dir with minifac installed via tarball,
  `minifac run sdd` loads the factory without error (with a
  mock executor or `--dry-run` semantics, depending on what
  the test harness allows).
- `<scope>/<name>` references throw a clear "not yet
  supported, see Reference.md" error rather than failing
  some other way.
- All existing tests pass.
- CLI / concept doc updates landed.
