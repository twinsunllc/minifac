import type { AutoMergeFailEventReason, AutorunEvent } from "../cli/autorun.js";
import { type RunState, type RunStateInit, createInitialRunState } from "./reducer.js";

export type BriefStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "succeeded-but-unmerged";

export interface BriefRowState {
  change: string;
  status: BriefStatus;
  runId?: string;
  skipReason?: string;
  autoMergeFailReason?: AutoMergeFailEventReason;
  runState?: RunState;
}

export type AutorunFocus = "brief-list" | "run-view";

export interface BriefListState {
  briefs: BriefRowState[];
  selectedBriefIndex: number;
  focus: AutorunFocus;
  quitConfirm: boolean;
  showHelp: boolean;
  /** Spinner tick. */
  tick: number;
  /** Process-level info: watch dir basename, max-concurrent (header). */
  watchBasename?: string;
  maxConcurrent?: number;
}

export type AutorunUIEvent =
  | { kind: "select-brief-next" }
  | { kind: "select-brief-prev" }
  | { kind: "enter-brief" }
  | { kind: "back-to-list" }
  | { kind: "request-quit" }
  | { kind: "confirm-quit" }
  | { kind: "cancel-quit" }
  | { kind: "toggle-help" }
  | { kind: "tick" }
  | {
      kind: "set-run-state";
      change: string;
      runState: RunState;
    };

export type AutorunReducerEvent = AutorunEvent | AutorunUIEvent;

export interface BriefListStateInit {
  watchBasename?: string;
  maxConcurrent?: number;
}

export function createInitialBriefListState(init: BriefListStateInit = {}): BriefListState {
  return {
    briefs: [],
    selectedBriefIndex: 0,
    focus: "brief-list",
    quitConfirm: false,
    showHelp: false,
    tick: 0,
    ...(init.watchBasename !== undefined ? { watchBasename: init.watchBasename } : {}),
    ...(init.maxConcurrent !== undefined ? { maxConcurrent: init.maxConcurrent } : {}),
  };
}

function isAutorunEvent(event: AutorunReducerEvent): event is AutorunEvent {
  switch ((event as { kind: string }).kind) {
    case "startup":
    case "poll-start":
    case "started":
    case "completed":
    case "skipped":
    case "dry-run-decision":
    case "info":
    case "auto-merge-failed":
      return true;
    default:
      return false;
  }
}

function findBrief(state: BriefListState, change: string): number {
  return state.briefs.findIndex((b) => b.change === change);
}

function upsertBrief(
  state: BriefListState,
  change: string,
  update: (row: BriefRowState) => BriefRowState,
): BriefListState {
  const idx = findBrief(state, change);
  if (idx === -1) {
    const row: BriefRowState = update({ change, status: "queued" });
    return { ...state, briefs: [...state.briefs, row] };
  }
  const existing = state.briefs[idx];
  if (!existing) return state;
  const next = update(existing);
  const briefs = state.briefs.slice();
  briefs[idx] = next;
  return { ...state, briefs };
}

function applyAutorunEvent(state: BriefListState, event: AutorunEvent): BriefListState {
  switch (event.kind) {
    case "startup":
    case "poll-start":
    case "info":
      return state;
    case "started":
      return upsertBrief(state, event.change, (row) => ({
        ...row,
        status: "running",
        ...(event.runId ? { runId: event.runId } : {}),
        skipReason: undefined,
      }));
    case "completed": {
      const status: BriefStatus = event.status === "succeeded" ? "succeeded" : "failed";
      return upsertBrief(state, event.change, (row) => ({
        ...row,
        status,
        ...(event.runId ? { runId: event.runId } : {}),
        skipReason: undefined,
      }));
    }
    case "skipped":
      return upsertBrief(state, event.change, (row) => {
        if (
          row.status === "running" ||
          row.status === "succeeded" ||
          row.status === "failed" ||
          row.status === "succeeded-but-unmerged"
        ) {
          return row;
        }
        return { ...row, status: "skipped", skipReason: event.reason };
      });
    case "dry-run-decision":
      if (event.action === "schedule") {
        return upsertBrief(state, event.change, (row) => ({
          ...row,
          status: "queued",
          skipReason: undefined,
        }));
      }
      return upsertBrief(state, event.change, (row) => ({
        ...row,
        status: "skipped",
        ...(event.reason ? { skipReason: event.reason } : {}),
      }));
    case "auto-merge-failed":
      return upsertBrief(state, event.change, (row) => {
        // Only `succeeded` (and `succeeded-but-unmerged` on a retry/refresh)
        // are valid predecessors per the `autorun-tui` spec's transition
        // table. Other statuses leave the row unchanged — they reflect a
        // protocol violation and the reducer SHALL NOT crash.
        if (row.status !== "succeeded" && row.status !== "succeeded-but-unmerged") {
          return row;
        }
        return {
          ...row,
          status: "succeeded-but-unmerged",
          autoMergeFailReason: event.reason,
        };
      });
  }
}

function applyUIEvent(state: BriefListState, event: AutorunUIEvent): BriefListState {
  switch (event.kind) {
    case "select-brief-next": {
      if (state.briefs.length === 0) return state;
      const next = Math.min(state.selectedBriefIndex + 1, state.briefs.length - 1);
      return { ...state, selectedBriefIndex: next };
    }
    case "select-brief-prev": {
      if (state.briefs.length === 0) return state;
      const next = Math.max(0, state.selectedBriefIndex - 1);
      return { ...state, selectedBriefIndex: next };
    }
    case "enter-brief": {
      const row = state.briefs[state.selectedBriefIndex];
      if (!row || !row.runState) return state;
      return { ...state, focus: "run-view" };
    }
    case "back-to-list":
      return { ...state, focus: "brief-list" };
    case "request-quit":
      return { ...state, quitConfirm: true };
    case "confirm-quit":
      return { ...state, quitConfirm: false };
    case "cancel-quit":
      return { ...state, quitConfirm: false };
    case "toggle-help":
      return { ...state, showHelp: !state.showHelp };
    case "tick":
      return { ...state, tick: state.tick + 1 };
    case "set-run-state": {
      const idx = findBrief(state, event.change);
      if (idx === -1) {
        const row: BriefRowState = {
          change: event.change,
          status: "running",
          runState: event.runState,
        };
        return { ...state, briefs: [...state.briefs, row] };
      }
      const existing = state.briefs[idx];
      if (!existing) return state;
      const briefs = state.briefs.slice();
      briefs[idx] = { ...existing, runState: event.runState };
      return { ...state, briefs };
    }
  }
}

export function autorunReducer(state: BriefListState, event: AutorunReducerEvent): BriefListState {
  if (isAutorunEvent(event)) return applyAutorunEvent(state, event);
  return applyUIEvent(state, event);
}

/** Helper for the renderer adapter: build a fresh `RunState` slot for a brief. */
export function makeRunStateSlot(init: RunStateInit): RunState {
  return createInitialRunState(init);
}
