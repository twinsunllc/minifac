import type { EmittedEvent } from "../executor/types.js";
import { type RenderedEvent, renderNodeEvent } from "./event-rendering.js";

export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "retrying";

export interface IterationLog {
  /** 1-based iteration number for the node. */
  iteration: number;
  /** Rendered events in arrival order. */
  events: RenderedEvent[];
  /** Set when a synthetic status event names a terminal outcome. */
  terminalStatus?: "succeeded" | "failed";
}

export interface NodeState {
  id: string;
  status: NodeStatus;
  /** 1-based iteration. 0 ⇒ node has not yet run. */
  iteration: number;
  iterations: IterationLog[];
}

export interface RunState {
  brief?: { change: string };
  factory: { name: string };
  /** Run-row branch name. When non-null and terminalStatus="succeeded",
   * the merge hint becomes available. */
  branchName: string | null;
  /** Declaration-order node ids. */
  nodes: NodeState[];
  selectedNodeId: string;
  selectedIteration: number;
  followMode: boolean;
  /** Index of the highlighted log line in the selected iteration's events. */
  highlightIndex: number;
  /** Lines toggled to show full JSON. Keyed by `${nodeId}|${iteration}|${eventIndex}`. */
  detailsOpen: Set<string>;
  /** Scroll offset for the log pane (0 = top). */
  scrollOffset: number;
  showHelp: boolean;
  showQuitPrompt: boolean;
  /** Terminal status for the whole run. */
  terminalStatus?: "succeeded" | "failed";
  terminalReason?: string;
  /** Tick counter for spinner frames. */
  tick: number;
}

export type UIEvent =
  | { kind: "navigate-up" }
  | { kind: "navigate-down" }
  | { kind: "enter-follow" }
  | { kind: "cycle-iteration-prev" }
  | { kind: "cycle-iteration-next" }
  | { kind: "scroll-log-up" }
  | { kind: "scroll-log-down" }
  | { kind: "toggle-details" }
  | { kind: "request-quit" }
  | { kind: "confirm-quit" }
  | { kind: "cancel-quit" }
  | { kind: "toggle-help" }
  | { kind: "terminate-run"; status: "succeeded" | "failed"; reason?: string }
  | { kind: "tick" };

export type ReducerEvent = UIEvent | EmittedEvent;

function isUIEvent(event: ReducerEvent): event is UIEvent {
  return (
    "kind" in event &&
    typeof (event as { kind: string }).kind === "string" &&
    !(event as Record<string, unknown>).nodeId
  );
}

export interface RunStateInit {
  brief?: { change: string };
  factory: { name: string };
  nodeIds: readonly string[];
  branchName?: string | null;
}

export function createInitialRunState(init: RunStateInit): RunState {
  const nodes: NodeState[] = init.nodeIds.map((id) => ({
    id,
    status: "pending",
    iteration: 0,
    iterations: [],
  }));
  return {
    factory: init.factory,
    ...(init.brief !== undefined ? { brief: init.brief } : {}),
    branchName: init.branchName ?? null,
    nodes,
    selectedNodeId: nodes[0]?.id ?? "",
    selectedIteration: 1,
    followMode: true,
    highlightIndex: 0,
    detailsOpen: new Set<string>(),
    scrollOffset: 0,
    showHelp: false,
    showQuitPrompt: false,
    tick: 0,
  };
}

function findNodeIndex(state: RunState, nodeId: string): number {
  return state.nodes.findIndex((n) => n.id === nodeId);
}

function runningNodeId(state: RunState): string | undefined {
  return state.nodes.find((n) => n.status === "running" || n.status === "retrying")?.id;
}

function cloneNodes(nodes: NodeState[]): NodeState[] {
  return nodes.map((n) => ({ ...n, iterations: n.iterations.slice() }));
}

function ensureIterationLog(node: NodeState, iteration: number): IterationLog {
  let entry = node.iterations.find((it) => it.iteration === iteration);
  if (!entry) {
    entry = { iteration, events: [] };
    node.iterations.push(entry);
    node.iterations.sort((a, b) => a.iteration - b.iteration);
  }
  return entry;
}

function applyRunEvent(state: RunState, event: EmittedEvent): RunState {
  const next = { ...state, nodes: cloneNodes(state.nodes) };
  const idx = findNodeIndex(next, event.nodeId);
  if (idx === -1) return state;
  const node = { ...next.nodes[idx] } as NodeState;
  node.iterations = node.iterations.slice();
  next.nodes[idx] = node;

  const rendered = renderNodeEvent(event);

  if (event.event.kind === "status") {
    const status = event.event.status;
    // started: ensure the iteration exists; status reflected via stdout
    if (status === "started") {
      node.iteration = Math.max(node.iteration, event.iteration);
      if (node.status === "pending") node.status = "running";
      ensureIterationLog(node, event.iteration);
    } else if (status === "succeeded" || status === "failed") {
      const log = ensureIterationLog(node, event.iteration);
      log.terminalStatus = status;
      node.status = status;
      node.iteration = Math.max(node.iteration, event.iteration);
    }
    // append the status event as a rendered line too so the log shows it
    const log = ensureIterationLog(node, event.iteration);
    log.events = log.events.concat(rendered);
  } else {
    // stdout / stderr
    const log = ensureIterationLog(node, event.iteration);
    if (node.status === "pending") {
      node.status = "running";
      node.iteration = Math.max(node.iteration, event.iteration);
    } else if (
      (node.status === "succeeded" || node.status === "failed") &&
      event.iteration > node.iteration
    ) {
      // A new iteration starting after a terminal one ⇒ retry.
      node.status = node.status === "failed" ? "retrying" : "running";
      // Then the line itself flips the live status to running.
      node.status = "running";
      node.iteration = event.iteration;
    } else if (node.status === "retrying") {
      node.status = "running";
      node.iteration = Math.max(node.iteration, event.iteration);
    } else {
      node.iteration = Math.max(node.iteration, event.iteration);
    }
    if (!rendered.suppressed) {
      log.events = log.events.concat(rendered);
    } else {
      // still retain suppressed events so `d` can surface them
      log.events = log.events.concat(rendered);
    }
  }

  // Follow mode: bring selection to the currently-running node.
  if (next.followMode) {
    const running = runningNodeId(next);
    if (running) {
      next.selectedNodeId = running;
      const runningNode = next.nodes.find((n) => n.id === running);
      if (runningNode) {
        next.selectedIteration = Math.max(1, runningNode.iteration);
      }
      next.highlightIndex = 0;
      next.scrollOffset = 0;
    }
  }

  return next;
}

function applyUIEvent(state: RunState, event: UIEvent): RunState {
  switch (event.kind) {
    case "navigate-up": {
      const idx = findNodeIndex(state, state.selectedNodeId);
      if (idx <= 0) return { ...state, followMode: false };
      const target = state.nodes[idx - 1];
      if (!target) return { ...state, followMode: false };
      return {
        ...state,
        selectedNodeId: target.id,
        selectedIteration: Math.max(1, target.iteration || 1),
        followMode: false,
        highlightIndex: 0,
        scrollOffset: 0,
      };
    }
    case "navigate-down": {
      const idx = findNodeIndex(state, state.selectedNodeId);
      if (idx === -1 || idx >= state.nodes.length - 1) return { ...state, followMode: false };
      const target = state.nodes[idx + 1];
      if (!target) return { ...state, followMode: false };
      return {
        ...state,
        selectedNodeId: target.id,
        selectedIteration: Math.max(1, target.iteration || 1),
        followMode: false,
        highlightIndex: 0,
        scrollOffset: 0,
      };
    }
    case "enter-follow": {
      const running = runningNodeId(state);
      if (running) {
        const runningNode = state.nodes.find((n) => n.id === running);
        return {
          ...state,
          followMode: true,
          selectedNodeId: running,
          selectedIteration: Math.max(1, runningNode?.iteration ?? 1),
          highlightIndex: 0,
          scrollOffset: 0,
        };
      }
      return { ...state, followMode: true };
    }
    case "cycle-iteration-prev": {
      const node = state.nodes.find((n) => n.id === state.selectedNodeId);
      if (!node) return state;
      const target = Math.max(1, state.selectedIteration - 1);
      return { ...state, selectedIteration: target, highlightIndex: 0, scrollOffset: 0 };
    }
    case "cycle-iteration-next": {
      const node = state.nodes.find((n) => n.id === state.selectedNodeId);
      if (!node) return state;
      const target = Math.min(node.iteration || 1, state.selectedIteration + 1);
      return { ...state, selectedIteration: target, highlightIndex: 0, scrollOffset: 0 };
    }
    case "scroll-log-up":
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset - 5) };
    case "scroll-log-down":
      return { ...state, scrollOffset: state.scrollOffset + 5 };
    case "toggle-details": {
      const key = `${state.selectedNodeId}|${state.selectedIteration}|${state.highlightIndex}`;
      const next = new Set(state.detailsOpen);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...state, detailsOpen: next };
    }
    case "request-quit": {
      if (state.terminalStatus) {
        // Terminal ⇒ no prompt; the renderer handles immediate exit.
        return state;
      }
      return { ...state, showQuitPrompt: true };
    }
    case "confirm-quit":
      return { ...state, showQuitPrompt: false };
    case "cancel-quit":
      return { ...state, showQuitPrompt: false };
    case "toggle-help":
      return { ...state, showHelp: !state.showHelp };
    case "terminate-run": {
      const out: RunState = {
        ...state,
        terminalStatus: event.status,
        ...(event.reason !== undefined ? { terminalReason: event.reason } : {}),
      };
      return out;
    }
    case "tick":
      return { ...state, tick: state.tick + 1 };
    default:
      return state;
  }
}

export function runReducer(state: RunState, event: ReducerEvent): RunState {
  if (isUIEvent(event)) return applyUIEvent(state, event);
  return applyRunEvent(state, event);
}

/** Returns true if the `m` hotkey is currently applicable. */
export function isMergeAvailable(state: RunState): boolean {
  return state.terminalStatus === "succeeded" && !!state.branchName;
}

/** Returns the visible events for the selected (node, iteration). */
export function visibleEvents(state: RunState): {
  events: RenderedEvent[];
  nodeId: string;
  iteration: number;
} {
  const node = state.nodes.find((n) => n.id === state.selectedNodeId);
  const empty = { events: [], nodeId: state.selectedNodeId, iteration: state.selectedIteration };
  if (!node) return empty;
  const log = node.iterations.find((it) => it.iteration === state.selectedIteration);
  if (!log) return empty;
  return {
    events: log.events.filter((e) => !e.suppressed),
    nodeId: node.id,
    iteration: log.iteration,
  };
}
