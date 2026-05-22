## 1. MCP SDK dependency

- [x] 1.1 Add `@modelcontextprotocol/sdk` as a runtime
      dependency in `package.json`, locked to a specific
      version that is at least 3 days old at lock time so the
      `cli.yml` dep-freshness gate passes. Record the version
      chosen in `design.md`'s Open Questions or a follow-up
      note if it deviates from the SDK's current latest.
- [x] 1.2 Update `package-lock.json` (or `pnpm-lock.yaml` /
      whichever lockfile this repo uses — confirm before
      running install) and verify the SDK installs cleanly on
      darwin + linux Node runtimes.
- [x] 1.3 Smoke-import the SDK in a throwaway test to confirm
      Node ESM/CJS interop works without runtime surprises.
- [x] 1.4 Update `docs/decisions/0024-CI-Security-Policy.md`
      to acknowledge the new MCP SDK dep in the
      verified-publisher discussion (one paragraph naming the
      dep and the freshness lock).

## 2. Runner — MCP server lifecycle

- [x] 2.1 Create `src/runner/mcp-server.ts` exporting the
      `RunnerMcpServer` interface and the
      `startRunnerMcpServer(runId, outputsRoot, onOutput)`
      factory. The server binds to a unix socket at
      `<outputs_root>/../mcp.sock`. Use the official MCP SDK
      for the JSON-RPC framing; do not hand-roll.
- [x] 2.2 The factory function SHALL mkdirp the socket's
      parent directory before binding, return a started server
      handle with `socketPath`, `registerNodeOutputs(nodeId,
      outputs)`, `clearNodeOutputs(nodeId)`, `close()`, and
      SHALL fail fast (rejecting the returned promise) if the
      socket cannot be bound (e.g. stale socket file present).
- [x] 2.3 In `src/runner/run.ts`, start the server in
      `runFactory`'s setup before any node is dispatched and
      `close()` it in the same `finally` block that closes
      the store. The socket file SHALL be removed by `close()`.
- [x] 2.4 Thread the server's `socketPath` through to
      `mcp-config` emission and the executor `ctx`.
- [x] 2.5 Tests in `src/runner/mcp-server.test.ts` covering
      every scenario in the graph-runner delta's "Per-run MCP
      server lifecycle" requirement.

## 3. Runner — per-node tool registration

- [x] 3.1 Implement `registerNodeOutputs(nodeId, outputs)` in
      `src/runner/mcp-server.ts`: derive a tool per `type:
      "value"` declared output, named
      `mcp__minifac__report_<key>`, with description and input
      schema derived per the "Per-node MCP tool registration"
      requirement.
- [x] 3.2 Schema-derivation helper: given an `OutputDef.shape`
      hint, return a zod-or-SDK schema accepting the
      corresponding loose shape (`array(unknown)`,
      `object({}).passthrough()`, primitives, or `unknown`).
      Centralize in `src/runner/mcp-schema.ts` for easy
      tightening when structural typing arrives.
- [x] 3.3 Implement `clearNodeOutputs(nodeId)` to de-register
      every tool registered for that node. Late tool calls
      arriving after de-registration SHALL return MCP
      "unknown tool" errors.
- [x] 3.4 In `src/runner/run.ts`, call `registerNodeOutputs`
      immediately before dispatching a node when its resolved
      executor's `supportsMcp` is `true`; call
      `clearNodeOutputs` immediately after the executor's
      event stream drains and before the post-execution
      validator runs.
- [x] 3.5 Skip tool registration entirely when
      `supportsMcp: false`. The runner still creates the
      outputs directory and runs the validator.
- [x] 3.6 Tests in `src/runner/mcp-server.test.ts` covering
      every scenario in the "Per-node MCP tool registration"
      requirement, including per-node scoping and the no-tools
      branch for non-MCP executors.

## 4. MCP-to-filesystem bridge

- [x] 4.1 In `src/runner/mcp-server.ts`, implement each
      registered tool's handler:
      (a) validate payload against the derived schema
      (defensive double-check);
      (b) serialize via `JSON.stringify(payload, null, 2)`
      with sorted keys;
      (c) write `<outputs_dir>/<key>.tmp-<random>.json`
      and `fs.rename` to `<outputs_dir>/<key>.json` atomically;
      (d) invoke the `onOutput(nodeId, key, value)` callback
      so the runner updates its in-memory tracking;
      (e) return an MCP success containing the absolute path.
- [x] 4.2 Random suffix generation: use `crypto.randomBytes`
      hex (8 bytes is plenty). Confirm the suffix grammar does
      not collide with the validator's `<key>.*` file-output
      glob (it won't — `<key>.json` is the only filename the
      validator matches for value outputs, and the `.tmp-*`
      sibling doesn't match because it's `<key>.tmp-*.json`,
      whose tail isn't `.json` as the full suffix; double-check
      this against the validator's existing globbing in
      `src/runner/validate-outputs.ts` and tighten the suffix
      naming if needed).
- [x] 4.3 Schema-mismatch path: return an MCP error to the
      model naming the output key and the validation detail;
      do NOT touch disk. Tests confirm the file is not
      created.
- [x] 4.4 Repeated calls: confirm the rename overwrites
      atomically and that the validator sees only the latest
      payload.
- [x] 4.5 Implement the `onOutput` callback wiring in
      `src/runner/run.ts` — update a per-dispatch
      `Map<key, "mcp" | "fs" | undefined>` that the validator
      reads to populate the `missing_outputs_detail` transport
      context.
- [x] 4.6 Tests in `src/runner/mcp-server.test.ts` covering
      every scenario in the "MCP-to-filesystem bridge"
      requirement (including the atomic-rename crash case via
      injected fault).

## 5. `.mcp.json` emission

- [x] 5.1 Create `src/runner/mcp-config.ts` exporting
      `writeMcpConfig(outputsDir, socketPath)`. The function
      writes `<outputsDir>/.mcp.json` with the SDK's
      recommended client config pointing at the run's socket.
      Confirm the SDK supports socket-direct config (no stdio
      wrapper script); fall back to a wrapper script only if
      strictly necessary.
- [x] 5.2 If a wrapper script is needed, ship it as
      `src/runner/mcp-stdio-wrapper.ts` (small, single-file)
      and reference it by absolute path in the emitted
      `.mcp.json`. Document the choice in `design.md`'s D5.
- [x] 5.3 In `src/runner/run.ts`, call `writeMcpConfig` before
      dispatching a node when the executor's `supportsMcp` is
      `true`; pass the resulting path through to the executor
      via `ctx.mcpConfigPath`.
- [x] 5.4 At run termination, sweep the `.mcp.json` files
      written during the run (collect their paths and `rm` in
      the `finally` block). The per-node outputs directories
      themselves are left for `prune --outputs`.
- [x] 5.5 Tests in `src/runner/mcp-config.test.ts` covering
      every scenario in the "Per-dispatch `.mcp.json` config
      emission" requirement.

## 6. Executor capability flag

- [x] 6.1 In `src/executor/types.ts`, add `readonly
      supportsMcp: boolean` to the `NodeExecutor` interface.
      Confirm the change compiles against every existing
      executor.
- [x] 6.2 In `src/executor/claude.ts`, set `supportsMcp =
      true`. When `ctx.mcpConfigPath` is a non-empty string,
      include `--mcp-config <path>` in the CLI argv ahead of
      any node-supplied flags.
- [x] 6.3 Confirm the executor registry's existing
      stub/mock executors used in tests are updated to declare
      `supportsMcp` (most likely `false`); the compilation
      step in 6.1 will surface them.
- [x] 6.4 Tests in `src/executor/claude.test.ts` confirming
      `--mcp-config` is passed when `ctx.mcpConfigPath` is set
      and omitted when it is not.
- [x] 6.5 Update `src/runner/ctx.ts` (or wherever the
      executor run context is shaped) to declare
      `mcpConfigPath?: string`.

## 7. Validator updates

- [x] 7.1 In `src/runner/validate-outputs.ts` (or wherever the
      post-execution validation lives), extend the
      `missing_outputs_detail` string for absent `value`
      outputs to mention the transport context: when MCP tools
      were available for the node, name the un-called tool;
      otherwise just name the absent file.
- [x] 7.2 Confirm the validator ignores `<key>.tmp-*.json`
      orphan files (their full filename doesn't match
      `<key>.json`; double-check the glob and add a test).
- [x] 7.3 Tests in `src/runner/validate-outputs.test.ts`
      covering every scenario the modified "Post-execution
      outputs validation" requirement added or revised
      (MCP-landed, Write-fallback, non-MCP fallback, absent
      with MCP available, absent without MCP, orphan
      `.tmp-*`).

## 8. Documentation

- [x] 8.1 Update `docs/concepts/Outputs.md` to describe the
      dual transport (filesystem fallback + MCP) and when each
      applies. Reference ADR-0029.
- [x] 8.2 Update `docs/Config.md` with a section noting the
      per-run MCP socket path. The path is NOT a `config.yaml`
      key; it is a computed per-run runtime detail.
- [x] 8.3 Confirm `docs/decisions/0024-CI-Security-Policy.md`
      is updated (per task 1.4).
- [x] 8.4 Add a short note in `docs/Roadmap.md` marking
      `node-outputs-mcp` as in-progress / shipped (whichever
      applies at archive time).

## 9. End-to-end testing

- [x] 9.1 An end-to-end test (`src/runner/run.e2e.test.ts` or
      similar) that runs a small two-node factory with a
      Claude-stubbed executor exercising the full MCP path:
      server starts, tools register, model calls a tool, file
      lands, validator passes, server stops. The Claude stub
      can mock the MCP-client side via the SDK's in-process
      client transport rather than spawning the real CLI.
- [x] 9.2 An end-to-end test exercising the non-MCP fallback:
      executor with `supportsMcp: false`, model writes file
      via direct filesystem path, validator passes.
- [x] 9.3 An end-to-end test for the `missing_required_output`
      override path under MCP — the model neither calls the
      tool nor writes the file, validator fires the override
      with the MCP-aware detail string.
- [x] 9.4 Confirm all existing tests in `node-outputs`
      (validator, schema, substitution, runs-storage,
      runs-cli) continue to pass without modification.

## 10. Spec archive prep

- [x] 10.1 After implementation lands and tests pass, run
      `openspec validate node-outputs-mcp --strict` and
      confirm clean.
- [x] 10.2 Mark all tasks above as `[x]` in this file as they
      complete; the archive step folds the deltas into the
      canonical capability specs.
