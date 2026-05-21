import { Box, Text } from "ink";
import type { ReactElement } from "react";

const ROWS: ReadonlyArray<[string, string]> = [
  ["↑ ↓ / j k", "move selection (pauses follow mode)"],
  ["Enter", "follow the running node"],
  ["PgUp / PgDn", "scroll the log pane"],
  ["< / >", "previous / next iteration of the selected node"],
  ["d", "toggle full JSON for the highlighted log line"],
  ["r", "switch to raw output for the rest of the run"],
  ["q", "quit (prompts for confirmation while a run is in flight)"],
  ["m", "merge (only on succeeded runs with a branch)"],
  ["?", "toggle this help overlay"],
];

export function HelpOverlay(): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>minifac · run TUI · hotkeys</Text>
      {ROWS.map(([k, v]) => (
        <Box key={k}>
          <Text color="yellow">{k.padEnd(14)}</Text>
          <Text> </Text>
          <Text>{v}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray">Below 80×24 the TUI falls back to a single-pane layout (log only).</Text>
      </Box>
    </Box>
  );
}
