/**
 * Resume-at-node: start a run at a named node with a previous run's results
 * already in scope, and the human's answer bound as feedback.
 *
 * A node that escalates fails with no `on_failure` edge, so the run ends
 * naming the node and its REASON line is the ask (scarif-factory FINDINGS
 * F7). Answering the ask has to reach that node again — not the graph's
 * start nodes — with everything the parked run had established still
 * readable. That is the whole of this module: the state shape the runner
 * takes (`ResumeState`), the reconstruction of that state from a finished
 * run's store rows (`resumeStateFromStore`), and the delimited block the
 * runner appends to the seeded dispatch's prompt (`humanAnswerBlock`).
 *
 * See `docs/decisions/0042-Resume-At-Node.md`.
 */

import type { NodeResult } from "../executor/types.js";
import type { NodeOutputIndex } from "../factory/schema.js";
import type { RunStore, StoredEvent } from "../storage/run-store.js";

/**
 * What the runner needs in order to resume a run at one node.
 *
 * `priorResults` and `iterations` are the parked run's state; the runner
 * rehydrates both before seeding the queue, so the resumed node's
 * templates resolve `{{ priorResults.<id>.* }}` exactly as they did and
 * its dispatch is numbered iteration n+1 rather than 1.
 */
export interface ResumeState {
  /** The node to dispatch first. Must name a node in the factory. */
  at: string;
  /** The parked run's per-node results, in completion order. */
  priorResults: NodeResult[];
  /** Per-node iteration counts already spent. Absent entries count as 0;
   * a count implied by `priorResults` is taken when it is higher, so a
   * caller that supplies only the results still gets correct numbering. */
  iterations?: Record<string, number>;
  /** The human's answer. Delivered twice: as `{{ run.feedback }}` for the
   * whole resumed run, and as a delimited block appended to the seeded
   * dispatch's prompt (ADR 0007's runner-injects precedent), so it reaches
   * the node whether or not the step binds the token. */
  feedback?: string;
}

/**
 * A follow-up run of earlier work (ADR 0043). The run starts at its declared
 * start nodes as usual; this only changes what `{{ run.follow_up }}` and
 * `{{ run.prior_asks }}` render. `priorAsks` is passed through as JSON
 * without interpretation — its shape belongs to the caller (Scarif sends
 * `{node_id, kind, answer, answered_at}` per answered ask).
 */
export interface FollowUpState {
  priorAsks?: unknown[];
}

/**
 * A split child's run context (ADR 0044): `{{ run.split }}`. Snake_case and
 * opaque, like `FollowUpState.priorAsks`: it is the claim's `factory.split`
 * passed through as Scarif sends it, and the runner only renders it.
 */
export interface SplitState {
  parent_work_item_id: string;
  /** Null when the parent's subject is a brief rather than a Jira issue. */
  parent_jira_key: string | null;
  /** The split's branch, which is this child's base. */
  parent_branch: string;
  /** 1-based. */
  child_index: number;
  child_count: number;
  /** This child's sub-tasks, as the parent's plan wrote them. */
  group: unknown[];
}

/**
 * A resumed split parent's integration context (ADR 0044):
 * `{{ run.split_integration }}`. Opaque to the runner, like `SplitState`.
 */
export interface SplitIntegrationState {
  children: unknown[];
  unmerged_sub_tasks: unknown[];
}

/** Headings of the run-context block prepended to a split run's prompts. */
export const SPLIT_CHILD_HEADING = "## Split child (run.split)";
export const SPLIT_INTEGRATION_HEADING = "## Split integration (run.split_integration)";

/**
 * The run-context block the runner prepends to every prompt of a split
 * child or a resumed split parent (ADR 0044), so the context reaches a node
 * whether or not its step binds `{{ run.split }}`. `null` when neither is
 * set, so an ordinary run's prompts are exactly their substituted templates.
 * Built AFTER substitution, so nothing in the JSON is read as a template.
 */
export function splitContextBlock(
  split: SplitState | null | undefined,
  splitIntegration: SplitIntegrationState | null | undefined,
): string | null {
  const sections: string[] = [];
  if (split) {
    sections.push(
      [
        SPLIT_CHILD_HEADING,
        "",
        `This run is child ${split.child_index} of ${split.child_count} of a split. Its base is the parent's branch,`,
        "and its scope is the group of sub-tasks below.",
        "",
        "```json",
        JSON.stringify(split, null, 2),
        "```",
      ].join("\n"),
    );
  }
  if (splitIntegration) {
    sections.push(
      [
        SPLIT_INTEGRATION_HEADING,
        "",
        "This run is a split parent resumed for integration after its children.",
        "",
        "```json",
        JSON.stringify(splitIntegration, null, 2),
        "```",
      ].join("\n"),
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

/** Heading of the block the runner appends to the seeded dispatch's prompt. */
export const HUMAN_ANSWER_HEADING = "## Human answer (resume)";

const HUMAN_ANSWER_FENCE = "-----BEGIN HUMAN ANSWER-----";
const HUMAN_ANSWER_FENCE_END = "-----END HUMAN ANSWER-----";

/**
 * The delimited human-answer block.
 *
 * Fenced rather than merely headed because the answer is arbitrary human
 * text that may itself contain markdown headings: the model has to be able
 * to tell where the answer stops and the step's own prompt resumed. The
 * block is appended AFTER template substitution, so nothing in the
 * answer is read as a template token.
 */
export function humanAnswerBlock(answer: string): string {
  return [
    HUMAN_ANSWER_HEADING,
    "",
    "A human answered the ask this run was parked on. This is their answer,",
    "verbatim. It is the authority for this dispatch.",
    "",
    HUMAN_ANSWER_FENCE,
    answer,
    HUMAN_ANSWER_FENCE_END,
  ].join("\n");
}

/** One `node_executions` row, as `resumeStateFromStore` needs it. */
export interface NodeExecutionRow {
  nodeId: string;
  iteration: number;
  status: "running" | "succeeded" | "failed" | "skipped";
  startedAt: number;
  endedAt: number | null;
  sessionId: string | null;
}

/** The read surface `resumeStateFromStore` needs off a store. */
export type ResumeReadStore = Pick<RunStore, "getRun" | "getNodeOutputs" | "getRunEvents"> & {
  getNodeExecutions?(runId: string): Promise<NodeExecutionRow[]>;
};

export interface ResumeStateFromStoreInput {
  store: ResumeReadStore;
  runId: string;
  /** The node to resume at. Validated against the factory by the runner, not
   * here: this function's job is the state, and a store read is not the
   * place to learn what nodes exist. */
  at: string;
  feedback?: string;
}

/** Raised when a run's state cannot be rebuilt. Carries an operator sentence. */
export class ResumeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeStateError";
  }
}

/**
 * Rebuild a finished run's `ResumeState` out of its store rows.
 *
 * One `NodeResult` per node, from its LATEST ended iteration — the same
 * latest-wins rule the runner's own `priorResults` map applies, so a node
 * that cycled resolves to the dispatch that actually produced the state
 * downstream saw.
 *
 * `reason` is recovered from the run's `status` events rather than from a
 * column: `node_executions` has no reason column (`sentinel_status` is
 * never written by the runner), and `{{ priorResults.<id>.reason }}` is
 * exactly what an escalation-aware step reads. A node whose status event
 * is no longer in the log resolves to `null` reason, which is what a
 * succeeded node carries anyway.
 */
export async function resumeStateFromStore(input: ResumeStateFromStoreInput): Promise<ResumeState> {
  const { store, runId, at } = input;

  const run = await store.getRun(runId);
  if (!run) {
    throw new ResumeStateError(`No run with id \`${runId}\` in the run store.`);
  }

  if (typeof store.getNodeExecutions !== "function") {
    throw new ResumeStateError(
      "This run store cannot read node executions, so a resume state cannot be rebuilt from it.",
    );
  }

  const executions = await store.getNodeExecutions(runId);
  const outputRows = await store.getNodeOutputs(runId);
  const reasons = await readNodeReasons(store, runId);

  // Outputs index per (node, iteration).
  const outputsByDispatch = new Map<string, NodeOutputIndex>();
  for (const row of outputRows) {
    const key = dispatchKey(row.nodeId, row.iteration);
    const index = outputsByDispatch.get(key) ?? {};
    index[row.outputKey] = {
      type: row.outputType,
      path: row.path,
      size: row.size,
      mtime: row.mtime,
    };
    outputsByDispatch.set(key, index);
  }

  // Latest ENDED dispatch per node, plus the highest iteration seen per node
  // (a `running` row still spent its iteration slot).
  const latest = new Map<string, NodeExecutionRow>();
  const iterations: Record<string, number> = {};
  for (const row of executions) {
    const seen = iterations[row.nodeId] ?? 0;
    if (row.iteration > seen) iterations[row.nodeId] = row.iteration;
    if (row.status === "running" || row.status === "skipped") continue;
    const current = latest.get(row.nodeId);
    if (!current || row.iteration > current.iteration) latest.set(row.nodeId, row);
  }

  const priorResults: NodeResult[] = [...latest.values()]
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    .map((row) => {
      const outputs = outputsByDispatch.get(dispatchKey(row.nodeId, row.iteration)) ?? null;
      const status = row.status === "succeeded" ? "succeeded" : "failed";
      return {
        nodeId: row.nodeId,
        iteration: row.iteration,
        status,
        reason:
          status === "failed"
            ? (reasons.get(dispatchKey(row.nodeId, row.iteration)) ?? null)
            : null,
        // Store timestamps are absolute epoch ms; `NodeResult` carries
        // ms-since-run-start. Rebased against the run's own start so a
        // rehydrated entry is on the same scale as one the resumed run
        // produces itself.
        startedAt: Math.max(0, row.startedAt - run.startedAt),
        endedAt: Math.max(0, (row.endedAt ?? row.startedAt) - run.startedAt),
        outputs: outputs && Object.keys(outputs).length > 0 ? outputs : null,
        nudges_used: 0,
        session_id: row.sessionId,
      } satisfies NodeResult;
    });

  return {
    at,
    priorResults,
    iterations,
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
  };
}

function dispatchKey(nodeId: string, iteration: number): string {
  return `${nodeId}#${iteration}`;
}

/**
 * The recorded `reason` per (node, iteration), read off the run's terminal
 * `status` events. The LAST status event for a dispatch wins, matching the
 * runner: it re-emits a `status` event when the missing-required-output
 * override fires, and that later reason is the one the run recorded.
 */
async function readNodeReasons(
  store: ResumeReadStore,
  runId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let events: StoredEvent[];
  try {
    events = await store.getRunEvents(runId, { kind: "status" });
  } catch {
    return out;
  }
  for (const event of events) {
    if (event.kind !== "status" || event.nodeId === null) continue;
    const reason = reasonFromStatusPayload(event.payload);
    const key = dispatchKey(event.nodeId, event.iteration);
    if (reason === null) {
      // A later succeeded status supersedes an earlier failure's reason.
      out.delete(key);
      continue;
    }
    out.set(key, reason);
  }
  return out;
}

/**
 * The reason carried by one persisted `status` event payload.
 *
 * Mirrors the runner's own `extractReason` — a sentinel failure's REASON
 * line, or a categorical reason that names itself — so a rehydrated
 * `{{ priorResults.<id>.reason }}` reads exactly what the parked run's
 * downstream nodes read.
 */
function reasonFromStatusPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as { status?: unknown; meta?: unknown };
  if (event.status !== "failed") return null;
  const meta = event.meta;
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { reason?: unknown; sentinel?: unknown };
  if (typeof m.sentinel === "string" && m.reason === "sentinel_failed") {
    return m.sentinel.replace(/\s+$/, "");
  }
  if (typeof m.reason === "string") return m.reason;
  return null;
}
