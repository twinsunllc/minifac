import type { Factory, FactoryNode, NodeOutputIndex } from "../factory/schema.js";

export type NodeEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | {
      kind: "status";
      status: "started" | "succeeded" | "failed";
      meta?: unknown;
    }
  // Runner-originated event: a one-line operator-visible narration of an
  // intervention the runner is performing on the executor's behalf
  // (e.g. nudging a missing-output protocol mistake). The event rides the
  // executor's event stream so downstream consumers see one ordered
  // timeline; the runner is the source, not the executor.
  | { kind: "runner-action"; line: string }
  // Runner-originated event: a synthetic user-message string the runner
  // is about to write to the executor's stdin (e.g. a nudge message).
  // Exposed on the event stream so observers see the same payload the
  // model receives.
  | { kind: "runner-nudge"; message: string };

/**
 * One entry per completed node execution. The runner accumulates these in
 * `priorResults` and threads them into each scheduled node's RunContext.
 * See `docs/decisions/0014-Structured-Prior-Results.md` and
 * `docs/decisions/0027-Node-Outputs.md`.
 */
export interface NodeResult {
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null;
  startedAt: number;
  endedAt: number;
  outputs: NodeOutputIndex | null;
  /** Count of in-turn nudge messages the runner wrote to the executor's
   * stdin during this node iteration (per the `graph-runner` capability's
   * "Post-execution nudge loop" requirement). `0` for nodes that never
   * entered the nudge loop (sentinel-failed, outputs-valid-first-try,
   * no `outputs:` declared, budget zero, non-nudge-capable executor).
   * Only incremented on successful stdin write — a failed write does
   * not consume a nudge because the model never received it. */
  nudges_used: number;
}

/**
 * One event emitted by a node executor, tagged with the emitting node and
 * its iteration. Used as the argument shape for the runner's `onEvent`
 * streaming callback and for raw event persistence in the Runs-DB. NOT
 * accumulated into per-node prompts — that's `priorResults`.
 */
export interface EmittedEvent {
  nodeId: string;
  iteration: number;
  emittedAt: number;
  event: NodeEvent;
}

export interface RunContext {
  factory: Factory;
  priorResults: readonly NodeResult[];
  nodeId: string;
  iteration: number;
  cwd: string;
  /** Absolute path to the per-node-per-iteration outputs directory. The
   * runner creates this directory (mkdirp) before invoking the executor. */
  outputsDir: string;
  /** Absolute path to the per-dispatch `.mcp.json` config file emitted by
   * the runner when the executor's `supportsMcp` is `true` and the run's
   * MCP server is in scope. Executors that speak MCP forward this to their
   * CLI's `--mcp-config` argument. Empty / undefined when the runner has
   * not emitted a config (e.g. unit-test invocations outside the runner,
   * or executors with `supportsMcp: false`). */
  mcpConfigPath?: string;
}

export type ResolvedNode = FactoryNode & { id: string };

export interface NodeExecutor {
  readonly type: string;
  /** Whether the executor's underlying runtime can connect to an MCP server
   * and invoke its tools. When `true`, the runner registers per-node MCP
   * tools for declared `type: "value"` outputs, emits a per-dispatch
   * `.mcp.json`, and threads its path through `ctx.mcpConfigPath`. When
   * `false`, all of the above are skipped and the executor falls back to
   * the filesystem-JSON transport for `value` outputs. See ADR-0029 and
   * the `node-executor` capability's "Executor `supportsMcp` capability
   * flag" requirement. */
  readonly supportsMcp: boolean;
  /** Whether the executor's underlying runtime can accept post-`result`
   * user messages on stdin (i.e. the runner can write an additional
   * stream-json user-message event after a `result` event lands and the
   * executor will produce a new turn of events). When `true`, the runner
   * enters the post-execution nudge loop on missing-required-output
   * detection (per ADR-0028 and the `graph-runner` capability's
   * "Post-execution nudge loop" requirement). When `false`, the runner
   * skips the loop entirely; the schema-accepted `output_nudge_budget`
   * has no runtime effect on those executors. */
  readonly supportsNudge: boolean;
  run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent>;
  /** When `supportsNudge` is `true`, the runner calls this method to
   * frame `msg` as a stream-json user-message event and write it to
   * the executor's stdin between `result` events. The returned promise
   * SHALL reject on stdin write failure (EPIPE, EBADF, OS error) so the
   * runner can record the broken-pipe failure path. When
   * `supportsNudge` is `false`, the method MAY be omitted. */
  writeUserMessage?(msg: string): Promise<void>;
}
