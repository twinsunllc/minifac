import { Box, Text, useInput, useStdout } from "ink";
import type { ReactElement } from "react";
import { MIN_TUI_ROWS, computeTuiRows } from "./app.js";
import type { AutorunUIEvent, BriefListState, BriefRowState } from "./autorun-reducer.js";
import { BriefListPane } from "./brief-list-pane.js";
import type { StatusGlyphs } from "./glyphs.js";
import { HelpOverlay } from "./help-overlay.js";
import { LogPane } from "./log-pane.js";
import { type ReducerEvent, type RunState, type UIEvent } from "./reducer.js";
import { StatusPane } from "./status-pane.js";

export interface AutorunHandlers {
  /** Dispatch an autorun-level UI event into the brief-list reducer. */
  dispatchAutorun: (event: AutorunUIEvent) => void;
  /** Dispatch a run-level UI event into the selected brief's RunState. */
  dispatchRun: (event: UIEvent | ReducerEvent) => void;
  /** Process-level handlers. */
  onRawSwitch: () => void;
  /** First quit: starts drain (if needed) and starts auto-exit; second escalates. */
  onQuit: () => void;
}

export interface AutorunAppProps {
  state: BriefListState;
  glyphs: StatusGlyphs;
  handlers: AutorunHandlers;
  /** Number of in-flight runs at the autorun-process level. */
  inFlight?: number;
  /** Optional fixed dimensions (tests). */
  columns?: number;
  rows?: number;
  inputEnabled?: boolean;
}

const MIN_COLS = 80;
const MIN_ROWS = 24;
const HEADER_ZONE_ROWS = 3;
const HOTKEY_ZONE_ROWS = 3;
const BRIEF_LIST_WIDTH = 24;

function selectedRow(state: BriefListState): BriefRowState | undefined {
  return state.briefs[state.selectedBriefIndex];
}

function HotkeyHint({
  state,
  inFlight,
}: {
  state: BriefListState;
  inFlight: number;
}): ReactElement {
  if (state.quitConfirm) {
    return (
      <Text color="yellow">
        Draining in-flight runs ({inFlight}). Press q again to force-quit.
      </Text>
    );
  }
  if (state.focus === "brief-list") {
    return (
      <Text color="gray">
        ↑/↓ select · Enter drill in · r raw · ? help · q quit
      </Text>
    );
  }
  return (
    <Text color="gray">
      ↑/↓ select node · Enter follow · &lt; &gt; iter · d details · Esc back to briefs · r raw · q
      quit
    </Text>
  );
}

function HeaderBar({
  state,
  inFlight,
}: {
  state: BriefListState;
  inFlight: number;
}): ReactElement {
  const watch = state.watchBasename ?? "inputs";
  const cap = state.maxConcurrent ?? 1;
  const row = selectedRow(state);
  return (
    <Box>
      <Text bold>minifac autorun</Text>
      <Text> · watch=</Text>
      <Text color="cyan">{watch}</Text>
      <Text> · in-flight=</Text>
      <Text color="yellow">
        {inFlight}/{cap}
      </Text>
      {state.focus === "run-view" && row?.runState ? (
        <>
          <Text> · brief: </Text>
          <Text color="cyan">{row.change}</Text>
          <Text> · factory: </Text>
          <Text color="cyan">{row.runState.factory.name}</Text>
        </>
      ) : null}
    </Box>
  );
}

function EmptyRunHint(): ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="gray">Press ↑/↓ to select a brief, Enter to drill in</Text>
    </Box>
  );
}

export function AutorunHotkeyInput({
  state,
  handlers,
  inFlight,
}: {
  state: BriefListState;
  handlers: AutorunHandlers;
  inFlight: number;
}): ReactElement {
  useInput((input, key) => {
    if (state.showHelp) {
      if (input === "?" || key.escape) {
        handlers.dispatchAutorun({ kind: "toggle-help" });
        return;
      }
      // fall through to other keys so users can still raw-switch / quit
    }
    if (input === "r") {
      handlers.onRawSwitch();
      return;
    }
    if (input === "q") {
      if (state.quitConfirm || inFlight === 0) {
        handlers.onQuit();
        return;
      }
      handlers.dispatchAutorun({ kind: "request-quit" });
      handlers.onQuit();
      return;
    }
    if (input === "?") {
      handlers.dispatchAutorun({ kind: "toggle-help" });
      return;
    }
    if (state.focus === "brief-list") {
      if (key.upArrow || input === "k") {
        handlers.dispatchAutorun({ kind: "select-brief-prev" });
        return;
      }
      if (key.downArrow || input === "j") {
        handlers.dispatchAutorun({ kind: "select-brief-next" });
        return;
      }
      if (key.return) {
        handlers.dispatchAutorun({ kind: "enter-brief" });
        return;
      }
      return;
    }
    // focus = "run-view": delegate to runReducer with a couple of overrides.
    if (key.escape) {
      handlers.dispatchAutorun({ kind: "back-to-list" });
      return;
    }
    if (key.upArrow || input === "k") {
      handlers.dispatchRun({ kind: "navigate-up" });
      return;
    }
    if (key.downArrow || input === "j") {
      handlers.dispatchRun({ kind: "navigate-down" });
      return;
    }
    if (key.return) {
      handlers.dispatchRun({ kind: "enter-follow" });
      return;
    }
    if (key.pageUp) {
      handlers.dispatchRun({ kind: "scroll-log-up" });
      return;
    }
    if (key.pageDown) {
      handlers.dispatchRun({ kind: "scroll-log-down" });
      return;
    }
    if (input === "<" || input === ",") {
      handlers.dispatchRun({ kind: "cycle-iteration-prev" });
      return;
    }
    if (input === ">" || input === ".") {
      handlers.dispatchRun({ kind: "cycle-iteration-next" });
      return;
    }
    if (input === "d") {
      handlers.dispatchRun({ kind: "toggle-details" });
      return;
    }
  });
  return <></>;
}

function RunView({ runState, glyphs }: { runState: RunState; glyphs: StatusGlyphs }): ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <StatusPane state={runState} glyphs={glyphs} />
      <LogPane state={runState} />
    </Box>
  );
}

export function AutorunApp({
  state,
  glyphs,
  handlers,
  inFlight = 0,
  columns,
  rows,
  inputEnabled = true,
}: AutorunAppProps): ReactElement {
  const stdoutHook = useStdout();
  const cols = columns ?? stdoutHook.stdout?.columns ?? 80;
  const fullRows = rows ?? stdoutHook.stdout?.rows ?? 24;
  const tuiRows = Math.max(MIN_TUI_ROWS, computeTuiRows(fullRows));
  const compact = cols < MIN_COLS || fullRows < MIN_ROWS;

  const bodyHeight = Math.max(1, tuiRows - HEADER_ZONE_ROWS - HOTKEY_ZONE_ROWS);

  const row = selectedRow(state);
  const runState = row?.runState;

  let body: ReactElement;
  if (compact) {
    // Single-pane fallback: only the brief list or only the embedded log,
    // depending on focus.
    if (state.focus === "brief-list" || !runState) {
      body = <BriefListPane state={state} glyphs={glyphs} />;
    } else {
      body = <LogPane state={runState} height={bodyHeight} />;
    }
  } else {
    body = (
      <>
        <Box flexDirection="column" width={BRIEF_LIST_WIDTH}>
          <BriefListPane state={state} glyphs={glyphs} />
        </Box>
        <Box
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          marginX={1}
        />
        <Box flexDirection="column" flexGrow={1}>
          {state.focus === "run-view" && runState ? (
            <RunView runState={runState} glyphs={glyphs} />
          ) : (
            <EmptyRunHint />
          )}
        </Box>
      </>
    );
  }

  return (
    <Box flexDirection="column" height={tuiRows}>
      <Box borderStyle="round" paddingX={1}>
        <HeaderBar state={state} inFlight={inFlight} />
      </Box>
      <Box borderStyle="round" paddingX={1} flexGrow={1}>
        {body}
      </Box>
      <Box borderStyle="round" paddingX={1}>
        <HotkeyHint state={state} inFlight={inFlight} />
      </Box>
      {state.showHelp ? <HelpOverlay /> : null}
      {inputEnabled ? (
        <AutorunHotkeyInput state={state} handlers={handlers} inFlight={inFlight} />
      ) : null}
    </Box>
  );
}
