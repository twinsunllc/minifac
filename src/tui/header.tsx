import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { RunState } from "./reducer.js";

export interface HeaderProps {
  state: RunState;
}

export function Header({ state }: HeaderProps): ReactElement {
  const briefLabel = state.brief ? state.brief.change : "(brief-less)";
  const running =
    state.nodes.find((n) => n.status === "running" || n.status === "retrying")?.id ??
    state.selectedNodeId;
  const status = state.terminalStatus ? ` · ${state.terminalStatus}` : "";
  const reason =
    state.terminalStatus === "failed" && state.terminalReason ? ` (${state.terminalReason})` : "";
  return (
    <Box>
      <Text bold>minifac</Text>
      <Text> · brief: </Text>
      <Text color="cyan">{briefLabel}</Text>
      <Text> · factory: </Text>
      <Text color="cyan">{state.factory.name}</Text>
      <Text> · </Text>
      <Text color="yellow">{running}</Text>
      <Text>{status}</Text>
      <Text>{reason}</Text>
    </Box>
  );
}
