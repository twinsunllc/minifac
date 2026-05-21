import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { type RunState, type UIEvent, isMergeAvailable } from "./reducer.js";

export interface HotkeyHandlers {
  dispatch: (event: UIEvent) => void;
  onRawSwitch: () => void;
  onQuit: () => void;
  onMerge: () => void;
}

export interface HotkeysProps {
  state: RunState;
  handlers: HotkeyHandlers;
}

function buildHint(state: RunState): string {
  const terminal = !!state.terminalStatus;
  if (state.showQuitPrompt) {
    return "Quit in-progress run? [y/N]";
  }
  if (terminal) {
    const mergeBit = isMergeAvailable(state) ? ", m to merge" : "";
    return `Run finished (${state.terminalStatus}). Press q to quit${mergeBit}.`;
  }
  const parts = ["↑/↓ nav", "Enter follow", "< > iter", "d details", "r raw", "? help", "q quit"];
  if (isMergeAvailable(state)) parts.push("m merge");
  return parts.join(" · ");
}

export function HotkeyBar({ state }: { state: RunState }): ReactElement {
  return (
    <Box>
      <Text color="gray">{buildHint(state)}</Text>
    </Box>
  );
}

export function HotkeyInput({ state, handlers }: HotkeysProps): ReactElement {
  useInput((input, key) => {
    if (state.showQuitPrompt) {
      if (input === "y" || input === "Y") {
        handlers.dispatch({ kind: "confirm-quit" });
        handlers.onQuit();
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        handlers.dispatch({ kind: "cancel-quit" });
        return;
      }
      return;
    }
    if (state.showHelp) {
      if (input === "?" || key.escape) {
        handlers.dispatch({ kind: "toggle-help" });
        return;
      }
    }
    if (key.upArrow || input === "k") {
      handlers.dispatch({ kind: "navigate-up" });
      return;
    }
    if (key.downArrow || input === "j") {
      handlers.dispatch({ kind: "navigate-down" });
      return;
    }
    if (key.return) {
      handlers.dispatch({ kind: "enter-follow" });
      return;
    }
    if (key.pageUp) {
      handlers.dispatch({ kind: "scroll-log-up" });
      return;
    }
    if (key.pageDown) {
      handlers.dispatch({ kind: "scroll-log-down" });
      return;
    }
    if (input === "<" || input === ",") {
      handlers.dispatch({ kind: "cycle-iteration-prev" });
      return;
    }
    if (input === ">" || input === ".") {
      handlers.dispatch({ kind: "cycle-iteration-next" });
      return;
    }
    if (input === "d") {
      handlers.dispatch({ kind: "toggle-details" });
      return;
    }
    if (input === "?") {
      handlers.dispatch({ kind: "toggle-help" });
      return;
    }
    if (input === "r") {
      handlers.onRawSwitch();
      return;
    }
    if (input === "q") {
      if (state.terminalStatus) {
        handlers.onQuit();
      } else {
        handlers.dispatch({ kind: "request-quit" });
      }
      return;
    }
    if (input === "m") {
      if (isMergeAvailable(state)) {
        handlers.onMerge();
      }
      return;
    }
  });
  return <></>;
}
