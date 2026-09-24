## 1. Runner

- [x] 1.1 `src/runner/resume.ts`: `FollowUpState`
- [x] 1.2 `src/runner/run.ts`: `RunOptions.followUp`; set
      `run.resumed_at`, `run.follow_up`, `run.prior_asks` on every run
- [x] 1.3 `src/runner/substitute.ts`: resolve the three tokens, with
      `""`, `false` and `[]` when absent
- [x] 1.4 `src/index.ts`: export `FollowUpState`

## 2. Tests

- [x] 2.1 `substitute.test.ts`: values, and the none-values
- [x] 2.2 `run.resume.test.ts`: resume at `plan` re-dispatches the gate
      with `resumed_at=plan`, the answer in `feedback` and no block
- [x] 2.3 `run.resume.test.ts`: a follow-up run renders `true` and the
      prior asks JSON; an ordinary run renders the none-values
- [x] 2.4 `run.resume.test.ts`: Scarif's default approve text reaches the
      seed as a block

## 3. Docs

- [x] 3.1 ADR 0043
- [x] 3.2 CHANGELOG
- [x] 3.3 Fold the delta into `openspec/specs/graph-runner/spec.md`
