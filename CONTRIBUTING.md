# Contributing to minifac

Thanks for your interest. minifac is small on purpose, so the bar for
new behavior is "does this make the core meaningfully better, or is it
a per-repo concern that belongs in your own factory definition?"

## Dev loop

```
npm install        # also runs `npm run build` via the prepare hook
npm test           # vitest
npm run check      # biome (lint + format check)
npm run build      # tsc + copy web assets
```

Node 22 or newer is required (see `engines.node` in `package.json`).

## How behavior changes happen

minifac uses Spec-Driven Development. See
[`docs/concepts/SDD-Loop.md`](docs/concepts/SDD-Loop.md). The short
version:

1. Write a brief in `inputs/<change>.md` describing the change.
2. Author an ADR in `docs/decisions/<NNNN>-<title>.md` capturing the
   binding design decision.
3. Run the SDD factory against the brief: `minifac run <change>`. It
   proposes (OpenSpec change), applies, verifies, and archives.
4. Open a PR pointing at the resulting run-scoped branch.

For tiny mechanical changes (typo fixes, doc tweaks, dependency
bumps) the factory is overkill — a regular PR is fine.

## GitHub Actions discipline

We pin every `uses:` reference by full commit SHA, with a comment
naming the human-readable version. New workflows (or updates) should
be processed with [`pinact`](https://github.com/suzuki-shunsuke/pinact)
or an equivalent before merge:

```
brew install pinact   # or: go install github.com/suzuki-shunsuke/pinact@latest
pinact run            # rewrites .github/workflows/ in place
```

We only consume actions from verified publishers (or first-party
`github/*` / `actions/*`). See
[`docs/decisions/0024-CI-Security-Policy.md`](docs/decisions/0024-CI-Security-Policy.md)
for the policy and the rationale.

## Dependency cooldown

Supply-chain hygiene — the nx postinstall worm and several
typosquats were caught and yanked within 24–72 hours of publish.
A 3-day cooldown forces malicious versions through that detection
window before we ever execute their postinstall hooks.

We enforce this in two places:

1. **Local resolve-time gate** via `.npmrc`:
   ```
   min-release-age=3
   ```
   `npm install` and `npm update` skip any package version
   published less than 3 days ago, picking an older one instead.
2. **Lockfile gate in CI** via `scripts/check-dep-freshness.mjs`
   (runs before `npm ci`). Catches lockfiles that were committed
   with freshly-published versions.

If you bump a dep and CI is red on freshness, just wait. For a
genuine same-day emergency (e.g., a CVE that needs an immediate
patch), set `MIN_DEP_AGE_DAYS=0` in the workflow with the
rationale in the PR description.

### Expected `.npmrc` warning noise

Every `npm` command currently prints two lines like:

```
npm warn Unknown project config "min-release-age". This will stop working in the next major version of npm.
npm warn Unknown user config "min-release-age". This will stop working in the next major version of npm.
```

This is **expected and harmless.** `min-release-age` is a real,
working npm config — npm just hasn't registered it in its
config-schema definitions yet, so npm 11.x treats it as
"unknown" and the boilerplate warning fires. The "will stop
working in the next major version" text is auto-generated and
misleading; the feature is staying. See
[npm/cli#9199](https://github.com/npm/cli/issues/9199).

### Known incompatibilities

`min-release-age` is a new feature in npm 11.x and has two
unresolved bugs that we don't trip today but you should know
about if you're touching dependencies:

- **Tilde version ranges** — adding a `~x.y.z` range to
  `package.json` while `.npmrc` has `min-release-age` set will
  cause `npm install` to fail with `--min-release-age cannot
  be provided when using --before`
  ([npm/cli#9005](https://github.com/npm/cli/issues/9005)).
  All our current deps use `^`, so we don't hit this. Stick to
  `^` until the upstream bug is fixed.
- **Git / GitHub URL dependencies** — `git:` or `github:`
  protocol deps combined with `min-release-age` make
  `npm install` fail with `git dep preparation failed`
  ([npm/cli#9291](https://github.com/npm/cli/issues/9291)). We
  have none. Prefer npm-registry deps; if a git dep is the only
  option, expect to drop `.npmrc` or work around it.

## Reporting issues

Open a GitHub issue. Include:

- minifac version (`minifac --version` once we ship that, or the
  commit SHA you're on)
- Node version
- A minimal factory + brief that reproduces the problem
- What you expected vs. what happened

## Security

Suspected security issues: please email rather than filing a public
issue. Contact info will land here once the repo is public.

## Code of conduct

Be kind. Disagreement is welcome; rudeness isn't. We'll add a formal
Contributor Covenant before the repo is publicized.
