## 1. CLI flag plumbing

- [x] 1.1 Add `--factory <name>` option to the `minifac run`
  subcommand parser in `src/cli.ts` (or wherever the `run` command
  is defined today). Accept any string; do not validate the shape
  at parse time.
- [x] 1.2 In the `run` handler, after the brief is resolved (steps
  1/2 of the run-cli resolution table), route the `--factory`
  value (when supplied) through the same `resolveFactoryByName`
  call that the brief's `factory:` field uses. Use the resolved
  factory (overridden or default) for everything downstream.
- [x] 1.3 When `--factory` is supplied alongside a brief-less
  resolution (step 3), exit `1` with a stderr message naming the
  conflict ("--factory is only meaningful with a brief"). Do not
  claim a lock, do not create a worktree.
- [x] 1.4 When `--factory` is supplied and resolution fails (unknown
  name, missing built-in path), surface the same "factory not
  found" error shape used today for an unresolved brief
  `factory:` field — include the offending name and the path(s)
  tried.

## 2. Lockfile key widening

- [x] 2.1 Update the brief-driven lockfile key derivation to
  produce `<repo-hash>-<change>-<factory-name>`. The
  `<factory-name>` is the resolved factory's top-level `name`
  (override-aware, post step-1.2).
- [x] 2.2 Leave the brief-less lockfile key derivation
  (`<repo-hash>-<factory-name>-<timestamp>`) unchanged.
- [x] 2.3 Verify the stale-lock detection branch operates per-key
  unchanged: PID parse, zero-signal probe, atomic replace.
- [x] 2.4 Confirm the lockfile error message includes the new wider
  key when a same-`(change, factory)` collision occurs (so the
  operator sees which factory the collision is against).

## 3. runs.db row content

- [x] 3.1 Confirm `factoryName` and `factoryPath` on the persisted
  run row reflect the resolved factory (the override-aware value,
  not the brief's declared value when overridden). No schema
  change; this is a code-path audit.
- [x] 3.2 Visually verify `minifac runs --change <change>` output
  surfaces the factory column legibly when two rows share a
  `change` but differ in `factoryName`.

## 4. Tests

- [x] 4.1 Add test: `minifac run foo` (no flag) — uses brief's
  declared factory; lockfile key is `<repo-hash>-foo-<declared>`;
  runs.db row carries `factoryName = <declared>`.
- [x] 4.2 Add test: `minifac run foo --factory bar` — resolves
  through `resolveFactoryByName` (local first, built-in fallback);
  runs.db row carries `factoryName = bar`; brief file unchanged.
- [x] 4.3 Add test: `minifac run foo --factory minifac:sdd` — skips
  local lookup; resolves to `examples/sdd.yaml`; persists
  accordingly.
- [x] 4.4 Add test: `minifac run foo --factory nonexistent` — exit
  `1`, stderr names `nonexistent` and both paths tried; no lock
  claimed, no worktree created.
- [x] 4.5 Add test: `minifac run foo --factory minifac:nonexistent`
  — exit `1`, stderr names the single built-in path tried; local
  `.minifac/factories/nonexistent.yaml` (if any) ignored.
- [x] 4.6 Add test: `minifac run hello --factory sdd` where
  `inputs/hello.md` does not exist and `examples/hello.yaml`
  exists (brief-less resolution) — exit `1`, stderr names the
  conflict; no lock, no worktree.
- [x] 4.7 Add concurrency test: two parallel `minifac run foo
  --factory A` and `--factory B` invocations — both claim distinct
  lockfiles, both create distinct worktrees on distinct branches,
  both runs are persisted, both succeed.
- [x] 4.8 Add concurrency test: two parallel
  `minifac run foo --factory A` invocations — one wins the lock,
  the other exits `1` with the existing "lock held by PID <p>"
  message naming the wider key.
- [x] 4.9 Confirm all existing run-cli, worktree-management, and
  brief-schema tests still pass with the wider lockfile key.

## 5. Documentation

- [x] 5.1 Update `docs/concepts/Brief.md`: describe `factory:` as
  the default factory, overridable at invocation time via
  `--factory`.
- [x] 5.2 Update `docs/concepts/Factory.md` "Composition" section
  to reference the invocation-time override and link to ADR 0020.
- [x] 5.3 Add a worked A/B example to `examples/sdd.md` (or the
  README, as fits the existing structure): "running the same brief
  through two factories." Show both `minifac run foo` and
  `minifac run foo --factory <other>`, and the
  `minifac runs --change foo` output that surfaces both attempts.
- [x] 5.4 Move the autorun-factory-flag open question in
  `docs/Open-Questions.md` from "open" to "deferred to auto-mode
  proposal" (the answer is "yes, when autorun lands").

## 6. Validate and archive

- [x] 6.1 Run `openspec validate factory-override-at-invocation`;
  iterate until it exits `0`.
- [x] 6.2 After implementation lands, run the full test suite;
  confirm no regression in pre-existing scenarios.
