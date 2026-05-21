import { Box, Text, useStdout } from "ink";
import type { ReactElement } from "react";
import { type StatusGlyphs, statusGlyph } from "./glyphs.js";
import { Header } from "./header.js";
import { HelpOverlay } from "./help-overlay.js";
import { HotkeyBar, type HotkeyHandlers, HotkeyInput } from "./hotkeys.js";
import { LogPane } from "./log-pane.js";
import { MergeOverlay, type MergeOverlayProps } from "./merge-overlay.js";
import type { RunState } from "./reducer.js";
import { StatusPane } from "./status-pane.js";

export interface RunAppProps {
  state: RunState;
  glyphs: StatusGlyphs;
  handlers: HotkeyHandlers;
  /** Optional fixed dimensions (tests use this to pin the layout). */
  columns?: number;
  rows?: number;
  mergeOverlay?: MergeOverlayProps | null;
  inputEnabled?: boolean;
}

const MIN_COLS = 80;
const MIN_ROWS = 24;

function QuitPrompt(): ReactElement {
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text color="yellow">Quit in-progress run? [y/N]</Text>
    </Box>
  );
}

export function RunApp({
  state,
  glyphs,
  handlers,
  columns,
  rows,
  mergeOverlay,
  inputEnabled = true,
}: RunAppProps): ReactElement {
  const stdoutHook = useStdout();
  const cols = columns ?? stdoutHook.stdout?.columns ?? 80;
  const rws = rows ?? stdoutHook.stdout?.rows ?? 24;
  const compact = cols < MIN_COLS || rws < MIN_ROWS;

  const node = state.nodes.find((n) => n.id === state.selectedNodeId);
  const prefix = node ? `${statusGlyph(glyphs, node.status)} ${node.id}` : "";

  return (
    <Box flexDirection="column">
      <Header state={state} />
      {compact ? (
        <LogPane state={state} prefix={prefix} />
      ) : (
        <Box>
          <Box flexDirection="column" width={24} marginRight={1}>
            <StatusPane state={state} glyphs={glyphs} />
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <LogPane state={state} />
          </Box>
        </Box>
      )}
      <HotkeyBar state={state} />
      {state.showQuitPrompt ? <QuitPrompt /> : null}
      {state.showHelp ? <HelpOverlay /> : null}
      {mergeOverlay ? <MergeOverlay {...mergeOverlay} /> : null}
      {inputEnabled ? <HotkeyInput state={state} handlers={handlers} /> : null}
    </Box>
  );
}
