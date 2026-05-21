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
