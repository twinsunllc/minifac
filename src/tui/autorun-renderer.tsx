import { render } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import type { AutorunEvent } from "../cli/autorun.js";
import type { EmittedEvent } from "../executor/types.js";
import { AutorunApp } from "./autorun-app.js";
import {
  type AutorunUIEvent,
  type BriefListState,
  autorunReducer,
  createInitialBriefListState,
  makeRunStateSlot,
} from "./autorun-reducer.js";
import { type StatusGlyphs, glyphsFor, pickGlyphSet } from "./glyphs.js";
import { type ReducerEvent, type RunStateInit, runReducer } from "./reducer.js";

export type AutorunRendererAction = "quit" | "raw-switch";

export interface AutorunRendererExitInfo {
  exitCode: number;
  action: AutorunRendererAction;
}

export interface InkAutorunRendererOptions {
  watchBasename?: string;
  maxConcurrent?: number;
  /** Build an initial `RunState` slot for a brief the first time a run event
   *  arrives for it. Called once per brief; cached in the BriefRowState. */
  resolveRunInit?: (change: string, hint: EmittedEvent) => RunStateInit | null;
  /** Source of the autorun-process-level in-flight counter. */
  getInFlight?: () => number;
  /** Called when the user presses `q`. The host SHALL initiate the autorun
   *  graceful-shutdown path. The renderer stays mounted until the host calls
   *  `unmount()`, OR until the second `q` press (which auto-unmounts with
   *  exit code 2). */
  onQuitRequested?: () => void;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

export interface InkAutorunRenderer {
  onEvent: (event: AutorunEvent) => void;
  onRunEvent: (change: string, entry: EmittedEvent) => void;
  /** Resolves once when the user / host dismisses the TUI. */
  waitForExit: () => Promise<AutorunRendererExitInfo>;
  requestQuit: () => void;
  requestRawSwitch: () => void;
  unmount: (info?: AutorunRendererExitInfo) => void;
  snapshot: () => BriefListState;
  /** Refresh the in-flight counter shown in the header. */
  setInFlight: (n: number) => void;
}

interface RendererBridge {
  onEvent: (event: AutorunEvent) => void;
  onRunEvent: (change: string, entry: EmittedEvent) => void;
  getState: () => BriefListState;
  setInFlight: (n: number) => void;
}

function RendererRoot({
  initialState,
  glyphs,
  bridgeRef,
  onRawSwitch,
  onQuit,
  resolveRunInit,
}: {
  initialState: BriefListState;
  glyphs: StatusGlyphs;
  bridgeRef: { current: RendererBridge | null };
  onRawSwitch: () => void;
  onQuit: () => void;
  resolveRunInit?: (change: string, hint: EmittedEvent) => RunStateInit | null;
}): ReactElement {
  const [state, setState] = useState<BriefListState>(() => initialState);
  const [inFlight, setInFlight] = useState<number>(0);

  const dispatchAutorun = (event: AutorunUIEvent): void => {
    setState((prev) => autorunReducer(prev, event));
  };
  const dispatchRun = (event: ReducerEvent): void => {
    setState((prev) => {
      const row = prev.briefs[prev.selectedBriefIndex];
      if (!row?.runState) return prev;
      const nextRun = runReducer(row.runState, event);
      const briefs = prev.briefs.slice();
      briefs[prev.selectedBriefIndex] = { ...row, runState: nextRun };
      return { ...prev, briefs };
    });
  };

  useEffect(() => {
    bridgeRef.current = {
      onEvent: (event) => {
        setState((prev) => autorunReducer(prev, event));
      },
      onRunEvent: (change, entry) => {
        setState((prev) => {
          const idx = prev.briefs.findIndex((b) => b.change === change);
          if (idx === -1) return prev;
          const row = prev.briefs[idx];
          if (!row) return prev;
          let slot = row.runState;
          if (!slot) {
            const init = resolveRunInit?.(change, entry);
            if (!init) return prev;
            slot = makeRunStateSlot(init);
          }
          const nextRun = runReducer(slot, entry);
          const briefs = prev.briefs.slice();
          briefs[idx] = { ...row, runState: nextRun };
          return { ...prev, briefs };
        });
      },
      getState: () => state,
      setInFlight: (n) => setInFlight(n),
    };
    return () => {
      bridgeRef.current = null;
    };
  });

  // Tick the spinner ~10 fps while any brief is running.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate
  useEffect(() => {
    const handle = setInterval(() => {
      if (state.briefs.some((b) => b.status === "running")) {
        dispatchAutorun({ kind: "tick" });
      }
    }, 100);
    return () => clearInterval(handle);
  }, []);

  return (
    <AutorunApp
      state={state}
      glyphs={glyphs}
      inFlight={inFlight}
      handlers={{
        dispatchAutorun,
        dispatchRun,
        onRawSwitch,
        onQuit,
      }}
    />
  );
}

export function createInkAutorunRenderer(
  options: InkAutorunRendererOptions = {},
): InkAutorunRenderer {
  const env = options.env ?? process.env;
  const glyphs = glyphsFor(pickGlyphSet(env));
  const initialState = createInitialBriefListState({
    ...(options.watchBasename !== undefined ? { watchBasename: options.watchBasename } : {}),
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
  });
  const bridgeRef: { current: RendererBridge | null } = { current: null };
  const getInFlight = options.getInFlight ?? (() => 0);

  let resolveExit: ((value: AutorunRendererExitInfo) => void) | null = null;
  const exitPromise = new Promise<AutorunRendererExitInfo>((res) => {
    resolveExit = res;
  });
  let quitPresses = 0;

  const unmount = (info?: AutorunRendererExitInfo): void => {
    if (!resolveExit) return;
    const out = info ?? { action: "quit" as const, exitCode: 0 };
    resolveExit(out);
    resolveExit = null;
    try {
      ink.unmount();
    } catch {
      // best effort
    }
  };

  const onRawSwitch = (): void => {
    unmount({ action: "raw-switch", exitCode: 0 });
  };

  const onQuit = (): void => {
    quitPresses += 1;
    const inFlight = getInFlight();
    if (quitPresses === 1 && inFlight === 0) {
      options.onQuitRequested?.();
      unmount({ action: "quit", exitCode: 0 });
      return;
    }
    if (quitPresses === 1) {
      // Drain path: ask host to stop scheduling; stay mounted.
      options.onQuitRequested?.();
      return;
    }
    // Second press ⇒ escalate.
    options.onQuitRequested?.();
    unmount({ action: "quit", exitCode: 2 });
  };

  const ink = render(
    <RendererRoot
      initialState={initialState}
      glyphs={glyphs}
      bridgeRef={bridgeRef}
      onRawSwitch={onRawSwitch}
      onQuit={onQuit}
      {...(options.resolveRunInit ? { resolveRunInit: options.resolveRunInit } : {})}
    />,
    {
      ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
      patchConsole: false,
    },
  );

  return {
    onEvent: (event) => {
      bridgeRef.current?.onEvent(event);
    },
    onRunEvent: (change, entry) => {
      bridgeRef.current?.onRunEvent(change, entry);
    },
    waitForExit: () => exitPromise,
    requestQuit: onQuit,
    requestRawSwitch: onRawSwitch,
    unmount,
    snapshot: () => bridgeRef.current?.getState() ?? initialState,
    setInFlight: (n) => {
      bridgeRef.current?.setInFlight(n);
    },
  };
}
