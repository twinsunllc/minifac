import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { type StatusGlyphs, statusGlyph } from "./glyphs.js";
import type { NodeState, NodeStatus, RunState } from "./reducer.js";
import { Spinner } from "./spinner.js";

function colorForStatus(status: NodeStatus, terminal: boolean): string | undefined {
  switch (status) {
    case "pending":
      return "gray";
    case "running":
      return "yellow";
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "retrying":
      return "yellow";
    default:
      return terminal ? undefined : undefined;
  }
}

export interface StatusPaneProps {
  state: RunState;
  glyphs: StatusGlyphs;
  width?: number;
}

function StatusRow({
  node,
  selected,
  isRunning,
  isTerminal,
  glyphs,
  tick,
}: {
  node: NodeState;
  selected: boolean;
  isRunning: boolean;
  isTerminal: boolean;
  glyphs: StatusGlyphs;
  tick: number;
}): ReactElement {
  const color = colorForStatus(node.status, isTerminal);
  const suffix = node.iteration > 1 ? ` (${node.iteration})` : "";
  const marker = selected ? "▸ " : "  ";
  const isLiveRunning = isRunning && !isTerminal;
  return (
    <Box>
      <Text>{marker}</Text>
      {isLiveRunning ? (
        <Spinner tick={tick} glyphs={glyphs} color={color} />
      ) : (
        <Text color={color}>{statusGlyph(glyphs, node.status)}</Text>
      )}
      <Text> </Text>
      <Text color={color}>{node.id}</Text>
      <Text>{suffix}</Text>
    </Box>
  );
}

export function StatusPane({ state, glyphs }: StatusPaneProps): ReactElement {
  const isTerminal = !!state.terminalStatus;
  return (
    <Box flexDirection="column">
      {state.nodes.map((node) => (
        <StatusRow
          key={node.id}
          node={node}
          selected={node.id === state.selectedNodeId}
          isRunning={node.status === "running" || node.status === "retrying"}
          isTerminal={isTerminal}
          glyphs={glyphs}
          tick={state.tick}
        />
      ))}
    </Box>
  );
}
