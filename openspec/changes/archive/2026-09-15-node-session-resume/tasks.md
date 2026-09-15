## 1. Live CLI checks (do these FIRST, before any code)

These pin assumptions the rest of the change rests on. Record each
answer inline in this file (edit the task line) so the implementation
and any later reader see the evidence, not the assumption.

All six ran against `claude` CLI **v2.1.223** on 2026-08-06. Outcomes
recorded inline below.

- [x] 1.1 Confirm `claude --print --verbose --input-format stream-json
      --output-format stream-json --resume <id>` accepts the prompt on
      **stdin** (not only as a positional argument). If it does not,
      stop and re-scope: the executor's whole stdin envelope depends
      on it.
      **PASS** — stdin-framed prompt accepted, exit 0, answer correct.
      No positional-prompt requirement.
- [x] 1.2 Confirm the resumed invocation emits a `system` / `init`
      stdout line carrying `session_id`, and that the value equals the
      resumed id. Capture one raw line verbatim for the executor test
      fixture.
      **PASS**, with a refinement that matters: `system` / `init` is
      emitted **once per turn**, not once per process — a two-turn
      dispatch produced two init lines, both carrying the resumed id.
      The spec's "last announcement in a dispatch wins" rule is
      therefore load-bearing. Line order is also not stable: the
      fresh run emitted a `rate_limit_event` line *before* init; the
      resumed run led with init. Both tolerated by the scan.
- [x] 1.3 Confirm mid-session stdin writes still work under
      `--resume`: write a second stream-json user-message frame after
      the first `result` event and confirm a new turn is produced.
      This is the nudge loop's precondition. If it fails, the spec
      narrows to "resume-declaring nodes must set
      `output_nudge_budget: 0`" — flag it before writing code.
      **PASS** — a probe mirroring the nudge loop (write frame, await
      `result`, write second frame to the live child's stdin, await
      second `result`, close) produced two turns and exit 0. The
      `output_nudge_budget: 0` narrowing is NOT needed.
- [x] 1.4 Confirm `--resume <id> --model <other>` is accepted, the
      turn runs on the override model, and the session jsonl's
      per-message `model` fields differentiate the pre- and
      post-swap turns (the cost-attribution premise).
      **PASS** — context survived the swap (a codeword planted on the
      default model was recalled by the resumed cheap-model turn with
      no artifact hand-off). The session jsonl carries per-message
      `message.model` + `usage`: the first turn's assistant message
      on the original model, the resumed turns on the override model.
      Cost split is possible. Observed cache behavior on the swap:
      ~13.5k cache-creation / ~17.7k cache-read on a toy session.
- [x] 1.5 Confirm behavior of `--resume` + `--mcp-config`: does the
      resumed session pick up the newly-passed config, restore the
      original invocation's servers, or both? Record the answer; it
      becomes a docs note in `docs/concepts/Executor.md`.
      **ANSWERED — the new config wins cleanly.** A session started
      with a probe server `alpha` and resumed with a config declaring
      only `beta` reported `beta` connected, no `alpha`, and only
      `mcp__beta__*` tools. Node A's per-dispatch output tools do not
      leak into node B's resumed session. Docs note only; no spec
      change.
- [x] 1.6 Record whether the CLI offers a fork-instead-of-append
      option for a resumed session. Not blocking — it feeds the
      `docs/Open-Questions.md` entry in § 8.
      **ANSWERED — `--fork-session` exists**: "When resuming, create a
      new session ID instead of reusing the original (use with
      --resume or --continue)". v1 still appends deliberately; the
      open question sharpens to "should `resume_mode: append | fork`
      be a v2 knob?", and the mechanism is named.

## 2. Factory schema + loader

- [x] 2.1 Add `resume: z.string().min(1).optional()` to `NodeSchema`
      in `src/factory/schema.ts`; the object stays `.strict()`.
- [x] 2.2 Preserve `resume` through step inlining, alongside the
      existing `outputs` / `output_nudge_budget` handling. Assert in
      a test that the inlined `with` body is byte-identical whether
      or not the node declares `resume:`.
- [x] 2.3 Add the post-schema validation pass over the **resolved**
      factory (after `extends:` merge and step inlining, alongside
      the existing terminal-node / cycle-budget / edge-endpoint
      checks): unknown target id → error naming declaring node,
      value, and source location; `resume` equal to the declaring
      node's own id → error; target `cwd` string ≠ declaring node's
      `cwd` string → error naming both node ids and both values.
      Both omitting `cwd` counts as identical.
- [x] 2.4 Do NOT add a reachability check. Add a test asserting that
      a `resume:` pointing at a node that can only run later loads
      without error (the failure is runtime, per the runner spec).
- [x] 2.5 Tests in `src/factory/*.test.ts` for each rule above plus:
      `resume:` alongside `uses:`, `resume:` surviving an `extends:`
      node override, empty-string / non-string rejection.

## 3. Executor interface + claude executor

- [x] 3.1 Add `resumeSessionId?: string` to `RunContext` and
      `readonly supportsResume: boolean` to `NodeExecutor` in
      `src/executor/types.ts`. Add `session_id: string | null` to
      `NodeResult` in the same file.
- [x] 3.2 Set `supportsResume = true` on `ClaudeExecutor`. Update
      every other `NodeExecutor` implementation (including test
      doubles and `src/executor/check-merge.ts`) — TypeScript strict
      will enumerate them.
- [x] 3.3 Extend `buildCliArgs` to take the resume session id and
      emit `--resume <id>` after the `--mcp-config` pair and before
      `--model`. Thread `ctx.resumeSessionId` at the call site in
      `ClaudeExecutor.run`.
- [x] 3.4 Update the argv section of the wire-format comment block at
      the top of `src/executor/claude.ts` to show `--resume` in its
      position, and note that `--resume` + `--model` is the intended
      composition (with the prompt-cache-invalidation consequence).
- [x] 3.5 Extend the argv snapshot tests in
      `src/executor/claude.test.ts`: `--resume` present with an id,
      absent without one (byte-identical to the pre-change snapshot),
      and the `--resume` + `--model` ordering case.

## 4. Runner: session capture

- [x] 4.1 In `src/runner/run.ts`, add a session-id scan beside the
      existing `parseTurnFromStdout` stdout inspection: a line
      parsing as JSON with `type === "system"`, `subtype === "init"`,
      and a non-empty string `session_id` updates a per-dispatch
      `lastSessionIdBox`. Parse failures and off-shape lines are
      ignored; no event is altered, suppressed, or reordered.
- [x] 4.2 Push `session_id` onto the `NodeResult` appended for the
      dispatch (`null` when nothing was captured), and pass
      `sessionId` to `store.recordNodeEnd(...)`.
- [x] 4.3 Tests in `src/runner/run.test.ts`: capture from the init
      line; last announcement wins; non-JSON / off-shape / non-string
      `session_id` ignored; `null` when no init line; capture happens
      for every dispatch regardless of terminal status.

## 5. Runner: resume resolution

- [x] 5.1 Before dispatch, when the resolved node declares `resume:`,
      look up the latest `priorResults` entry for the named node
      (reuse the `priorMap` the runner already builds) and read its
      `session_id`.
- [x] 5.2 Fail before spawn, yielding a terminal `failed` status and
      appending a `NodeResult` with the matching reason, for:
      no prior dispatch (`resume_unavailable`, detail
      `no_prior_dispatch`); prior dispatch with `session_id === null`
      (`resume_unavailable`, detail `no_session_captured`); resolved
      executor with `supportsResume === false`
      (`resume_unsupported`). No fresh-session fallback in any case.
- [x] 5.3 On success, set `ctx.resumeSessionId` for the dispatch.
      Nodes without `resume:` get a context with the field absent.
- [x] 5.4 Confirm the pre-spawn failure path still does everything a
      dispatched-node failure does: `recordNodeStart` /
      `recordNodeEnd` bracketing, the `log` entry, the status event
      on `onEvent`, and edge traversal (`on_failure` edges must fire).
- [x] 5.5 Tests in `src/runner/run.test.ts`: resolves the target's
      captured session; a later iteration picks up the target's
      newer session after the target re-ran; a repeated iteration
      without a target re-run reuses the same id; failed-target-
      with-session still resumes; each of the three pre-spawn
      failure reasons; no spawn occurs in those cases (assert
      against the spawn double); `on_failure` edge traverses off a
      `resume_unavailable` failure.

## 6. Storage

- [x] 6.1 Add `src/storage/migrations/0004_add_session_id.sql` with
      `ALTER TABLE node_executions ADD COLUMN session_id TEXT;` and
      mirror it in the inline `MIGRATIONS` array with `version: 4`,
      `name: "add_session_id"`.
- [x] 6.2 Add `sessionId?: string | null` to `RecordNodeEndInput` in
      `src/storage/run-store.ts`; bind it in the `recordNodeEnd`
      UPDATE/INSERT in `src/storage/sqlite.ts` (`NULL` when omitted);
      project the column as `sessionId` in any node-execution SELECT
      on the public API.
- [x] 6.3 Tests in `src/storage/sqlite.test.ts`: fresh DB reaches
      `schema_version 4` with the column present; a seeded v3 DB
      migrates without touching other tables and leaves existing
      rows `NULL`; `recordNodeEnd` round-trips a session id and a
      `null`; two rows in one run may share a session id.

## 7. Example / smoke factory

- [x] 7.1 Add a minimal cascade to `examples/` (or a fixture factory
      under the runner tests, if the maintainer prefers not to grow
      the shipped examples): a plan node on the default model and a
      continuation node declaring `resume: <plan>` plus a
      `with.model` override, sharing one `cwd`.
      **Took the second option — no new shipped example.** `examples/`
      is bundled as built-in `minifac:<name>` surface, and CLAUDE.md
      pins the shipped set at exactly two factories (`hello`, `sdd`).
      A third would be new public surface for a demo. The cascade is
      instead covered structurally by the runner tests (§ 5.5) and
      documented as a copy-pasteable YAML snippet in
      `docs/concepts/Factory.md`, which is what a factory author (and
      the eval) actually needs. Say the word if you'd rather ship
      `examples/cascade.yaml` — it's one small file plus a CLAUDE.md
      line.
- [x] 7.2 Manual smoke: run it end-to-end and confirm (a) the
      continuation node's session id equals the plan node's,
      (b) `node_executions` carries both rows with that id, and
      (c) the continuation node demonstrably has the plan node's
      context without an artifact hand-off. Not part of automated CI.
      **PASS on all three.** Hand-written cascade in a scratch repo:
      `plan` (default model) read a config file via a tool call and
      summarized it; `apply` (`resume: plan`, `model: haiku`) was told
      NOT to read any file and wrote two exact values from that file
      to disk. Run succeeded, `recalled.txt` =
      `retry_ceiling=47 owner=quill-brannigan`, and both
      `node_executions` rows carry session
      `f1e9778c-3bfe-4238-9777-4102b0d16165`. The cheap node inherited
      the expensive node's exploration with no artifact hand-off.
      **Worth knowing (the first attempt failed and taught us
      something):** an earlier probe asked `plan` to invent a
      passphrase and "remember it" while replying only `READY`. The
      resumed node correctly reported it could not recall it. What
      transfers is the **conversation transcript**, not hidden
      reasoning — a cascade carries only what the upstream node
      actually put into its messages and tool calls. Prompt plan nodes
      accordingly.

## 8. Docs

- [x] 8.1 `docs/concepts/Factory.md`: the `resume:` node field — what
      it points at, the three load-time rules (declared target, no
      self-resume, matching `cwd`), and that reachability is not
      checked.
- [x] 8.2 `docs/concepts/Executor.md`: `supportsResume`, `--resume`'s
      argv position, that `--resume` + `--model` is the intended
      cascade, and that the model swap invalidates the conversation
      prompt cache (so the resumed turn re-sends history uncached —
      expected, not a regression).
- [x] 8.3 `docs/concepts/Runner.md`: session capture, the latest-
      dispatch resolution rule, the `resume_unavailable` /
      `resume_unsupported` reasons and the deliberate no-fallback
      stance, and the append-not-snapshot consequence (a resumed
      node in a cycle accumulates context across iterations).
- [x] 8.4 `docs/concepts/Runs-DB.md`: the `session_id` column, that
      it is nullable and non-unique, and what it is for (joining a
      finished run to its transcripts for cost attribution).
- [x] 8.5 `docs/Open-Questions.md`: append-vs-fork semantics for a
      resumed session across iterations, with the named trigger
      "a factory hits context limits inside a resumed revise loop";
      fold in whatever § 1.6 found.

## 9. Verify

- [x] 9.1 `npm test` — full suite green, including the unchanged
      argv snapshots for non-resume nodes.
- [x] 9.2 `npm run check` (biome) clean.
- [x] 9.3 `openspec validate node-session-resume --strict` clean.
