## 1. Runner

- [x] 1.1 `src/runner/resume.ts`: `ResumeState`, `humanAnswerBlock`,
      `resumeStateFromStore`, `ResumeStateError`
- [x] 1.2 `src/runner/run.ts`: `RunOptions.resume`; seed the queue with
      `at` alone, rehydrate `priorResults` and `iterations`, exempt the
      seed from `max_iterations`, leave `edgeTraversals` empty, narrate
      the seed as a `runner-action` event
- [x] 1.3 `src/runner/run.ts`: fail cleanly with `resume_unknown_node`
      (new `RunReason`) when `at` names no node, dispatching nothing
- [x] 1.4 `src/runner/run.ts`: append the human-answer block to the
      seeded dispatch's `with.prompt` only, after substitution
- [x] 1.5 `src/runner/substitute.ts`: `{{ run.feedback }}`
- [x] 1.6 `src/index.ts`: export the resume types and helpers (the
      package publishes only its root entry)

## 2. Storage

- [x] 2.1 `RunStore`: optional `getNodeExecutions`, optional
      `reopenRun`, `GetEventsOptions.kind`
- [x] 2.2 SQLite adapter: implement all three
- [x] 2.3 `runFactory` calls `reopenRun` on a resume when the store has
      it, and `createRun` otherwise

## 3. CLI

- [x] 3.1 `minifac run --resume <run> --at <node> [--feedback <file>]`
      in `src/cli/resume-run.ts`, wired in `src/cli.ts`
- [x] 3.2 The positional argument becomes optional and is mutually
      exclusive with `--resume`; `--in-place`, `--force`,
      `--require-clean` and `--factory` are refused with it
- [x] 3.3 Six named refusals: unknown run, ambiguous prefix, missing
      `--at`, unknown node, missing worktree, unreadable feedback file

## 4. Tests

- [x] 4.1 Seeded node dispatches first and no start node runs; prior
      results readable in the resumed prompt
- [x] 4.2 Seed exempt from `max_iterations`; the next traversal is not
- [x] 4.3 An `on_failure` edge with an exhausted-looking budget still
      traverses once after resume
- [x] 4.4 Feedback token substitutes; the injected block appears on the
      seed and not on iteration 2
- [x] 4.5 Unknown `at` fails `resume_unknown_node` and dispatches nothing
- [x] 4.6 `resumeStateFromStore` against a seeded SQLite store
- [x] 4.7 `reopenRun` puts a finished run back to running
- [x] 4.8 CLI: same run row continued, executions appended, no worktree;
      every refusal path exits non-zero with its message

## 5. Docs

- [x] 5.1 ADR 0042 (with the edge-counter consequence stated and
      traversal persistence deferred)
- [x] 5.2 `docs/CLI.md` `--resume` section
- [x] 5.3 `CHANGELOG.md`

## 6. Verify

- [x] 6.1 `npm run build`, `npx biome check .`, `npm test`,
      `npx openspec validate --all --strict`
