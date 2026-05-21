import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import type { EmittedEvent } from "../executor/types.js";
import { RunApp } from "./app.js";
import { type StatusGlyphs, glyphsFor, pickGlyphSet } from "./glyphs.js";
import type { MergeOverlayProps } from "./merge-overlay.js";
import {
  type ReducerEvent,
  type RunState,
  type RunStateInit,
  createInitialRunState,
  runReducer,
} from "./reducer.js";

export interface InkRunRendererOptions {
  brief?: { change: string };
  factory: { name: string };
  nodeIds: readonly string[];
  branchName?: string | null;
  /** Output stream used by ink. Defaults to process.stdout. */
  stdout?: NodeJS.WriteStream;
  /** Input stream used by ink. Defaults to process.stdin. */
  stdin?: NodeJS.ReadStream;
  /** Stderr used by ink. Defaults to process.stderr. */
  stderr?: NodeJS.WriteStream;
  /** Env used to pick glyph set. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional override for the merge invocation. Tests inject a mock. */
  invokeMerge?: (
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export type RendererAction = "quit" | "raw-switch" | "merge";

export interface InkRunRenderer {
  onEvent: (entry: EmittedEvent) => void;
  /** Resolves when the user dismisses the TUI. */
  waitForExit: () => Promise<{ action: RendererAction }>;
  /** Programmatic quit (e.g. confirmation handler). */
  requestQuit: () => void;
  /** Forced terminate (called by CLI when run promise settles). */
  terminate: (status: "succeeded" | "failed", reason?: string) => void;
  /** Returns the current run state snapshot (testing). */
  snapshot: () => RunState;
}

interface RendererBridge {
  onEvent: (entry: EmittedEvent) => void;
  setMerge: (props: MergeOverlayProps | null) => void;
  requestRawSwitch: () => void;
  requestQuit: () => void;
  terminate: (status: "succeeded" | "failed", reason?: string) => void;
  getState: () => RunState;
}

function RendererRoot({
  init,
  glyphs,
  bridgeRef,
  onRawSwitch,
  onQuit,
  onMerge,
}: {
  init: RunStateInit;
  glyphs: StatusGlyphs;
  bridgeRef: { current: RendererBridge | null };
  onRawSwitch: () => void;
  onQuit: () => void;
  onMerge: () => void;
}): ReactElement {
  const [state, setState] = useState<RunState>(() => createInitialRunState(init));
  const [mergeOverlay, setMergeOverlay] = useState<MergeOverlayProps | null>(null);

  const dispatch = (event: ReducerEvent) => {
    setState((prev) => runReducer(prev, event));
  };

  useEffect(() => {
    bridgeRef.current = {
      onEvent: (entry: EmittedEvent) => dispatch(entry),
      setMerge: setMergeOverlay,
      requestRawSwitch: () => onRawSwitch(),
      requestQuit: () => onQuit(),
      terminate: (status, reason) =>
        dispatch({ kind: "terminate-run", status, ...(reason !== undefined ? { reason } : {}) }),
      getState: () => state,
    };
    return () => {
      bridgeRef.current = null;
    };
  });

  // Tick the spinner ~10 fps while a run is live.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is stable (setState wrapper)
  useEffect(() => {
    if (state.terminalStatus) return;
    const interval = setInterval(() => {
      dispatch({ kind: "tick" });
    }, 100);
    return () => clearInterval(interval);
  }, [state.terminalStatus]);

  // Dismiss merge overlay on any key press once it has settled.
  // (Handled inline because hotkeys live in HotkeyInput.)
  const handlers = {
    dispatch,
    onRawSwitch,
    onQuit,
    onMerge,
  };

  return <RunApp state={state} glyphs={glyphs} handlers={handlers} mergeOverlay={mergeOverlay} />;
}

async function defaultInvokeMerge(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Re-enter the CLI in-process by spawning the same node binary on dist/cli.js.
  // For an in-process router we'd need to factor commander setup out of runCli;
  // a child invocation keeps the change small and isolates stdio capture.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const cliJs = `${here}../cli.js`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliJs, "merge", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + (err.message ?? ""), exitCode: 1 });
    });
  });
}

export function createInkRunRenderer(options: InkRunRendererOptions): InkRunRenderer {
  const env = options.env ?? process.env;
  const glyphs = glyphsFor(pickGlyphSet(env));
  const init: RunStateInit = {
    factory: options.factory,
    nodeIds: options.nodeIds,
    branchName: options.branchName ?? null,
    ...(options.brief !== undefined ? { brief: options.brief } : {}),
  };
  const bridgeRef: { current: RendererBridge | null } = { current: null };

  let resolveExit: ((value: { action: RendererAction }) => void) | null = null;
  const exitPromise = new Promise<{ action: RendererAction }>((res) => {
    resolveExit = res;
  });

  const onRawSwitch = () => {
    if (!resolveExit) return;
    resolveExit({ action: "raw-switch" });
    resolveExit = null;
    ink.unmount();
  };
  const onQuit = () => {
    if (!resolveExit) return;
    resolveExit({ action: "quit" });
    resolveExit = null;
    ink.unmount();
  };
  const onMerge = async () => {
    const state = bridgeRef.current?.getState();
    if (!state || state.terminalStatus !== "succeeded" || !state.branchName) return;
    const target = state.brief?.change ?? state.branchName;
    bridgeRef.current?.setMerge({ stdout: "", stderr: "", exitCode: null, pending: true });
    const invoke = options.invokeMerge ?? defaultInvokeMerge;
    const result = await invoke([target]);
    bridgeRef.current?.setMerge({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      pending: false,
    });
  };

  const ink = render(
    <RendererRoot
      init={init}
      glyphs={glyphs}
      bridgeRef={bridgeRef}
      onRawSwitch={onRawSwitch}
      onQuit={onQuit}
      onMerge={onMerge}
    />,
    {
      ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
      patchConsole: false,
    },
  );

  return {
    onEvent: (entry) => {
      bridgeRef.current?.onEvent(entry);
    },
    waitForExit: () => exitPromise,
    requestQuit: onQuit,
    terminate: (status, reason) => bridgeRef.current?.terminate(status, reason),
    snapshot: () => bridgeRef.current?.getState() ?? createInitialRunState(init),
  };
}
