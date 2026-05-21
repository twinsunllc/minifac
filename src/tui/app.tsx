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
export const MIN_TUI_ROWS = 24;

// Each bordered zone contributes top + bottom border lines.
// The header and hotkey bar each carry one row of content inside their
// border, for a total of 3 rows of vertical space per zone.
const HEADER_ZONE_ROWS = 3;
const HOTKEY_ZONE_ROWS = 3;

/** Compute the bounded outer TUI height for a given terminal row count. */
export function computeTuiRows(fullRows: number): number {
  return Math.max(MIN_TUI_ROWS, Math.floor(fullRows / 2));
}

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
  const fullRows = rows ?? stdoutHook.stdout?.rows ?? 24;
  const tuiRows = computeTuiRows(fullRows);
  const compact = cols < MIN_COLS || fullRows < MIN_ROWS;

  // Body height is derived from the bounded outer height, minus the
  // header and hotkey bar zones. The log pane gets this value via its
  // explicit `height` prop so its scroll/limit math uses the right
  // value rather than the unbounded terminal row count.
  const bodyHeight = Math.max(1, tuiRows - HEADER_ZONE_ROWS - HOTKEY_ZONE_ROWS);

  const node = state.nodes.find((n) => n.id === state.selectedNodeId);
  const prefix = node ? `${statusGlyph(glyphs, node.status)} ${node.id}` : "";

  return (
    <Box flexDirection="column" height={tuiRows}>
      <Box borderStyle="round" paddingX={1}>
        <Header state={state} />
      </Box>
      <Box borderStyle="round" paddingX={1} flexGrow={1}>
        {compact ? (
          <LogPane state={state} prefix={prefix} height={bodyHeight} />
        ) : (
          <>
            <Box flexDirection="column" width={24}>
              <StatusPane state={state} glyphs={glyphs} />
            </Box>
            {/* Vertical rule: a 1-column Box with only its left border
                renders without seams against the body's round border. */}
            <Box
              borderStyle="single"
              borderTop={false}
              borderBottom={false}
              borderRight={false}
              marginX={1}
            />
            <Box flexDirection="column" flexGrow={1}>
              <LogPane state={state} height={bodyHeight} />
            </Box>
          </>
        )}
      </Box>
      <Box borderStyle="round" paddingX={1}>
        <HotkeyBar state={state} />
      </Box>
      {state.showQuitPrompt ? <QuitPrompt /> : null}
      {state.showHelp ? <HelpOverlay /> : null}
      {mergeOverlay ? <MergeOverlay {...mergeOverlay} /> : null}
      {inputEnabled ? <HotkeyInput state={state} handlers={handlers} /> : null}
    </Box>
  );
}
