import { Box, Text } from "ink";
import type { ReactElement } from "react";

export interface MergeOverlayProps {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the merge subprocess is still running. */
  pending: boolean;
}

export function MergeOverlay({
  stdout,
  stderr,
  exitCode,
  pending,
}: MergeOverlayProps): ReactElement {
  const status = pending
    ? "running…"
    : exitCode === 0
      ? "succeeded"
      : `failed (exit ${exitCode ?? "?"})`;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>minifac merge · {status}</Text>
      {stdout.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">stdout</Text>
          {stdout
            .split(/\n/)
            .filter((l) => l.length > 0)
            .map((l, i) => (
              <Text key={`o${i}:${l}`}>{l}</Text>
            ))}
        </Box>
      ) : null}
      {stderr.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">stderr</Text>
          {stderr
            .split(/\n/)
            .filter((l) => l.length > 0)
            .map((l, i) => (
              <Text key={`e${i}:${l}`} color="red">
                {l}
              </Text>
            ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">{pending ? "(running)" : "Press any key to dismiss."}</Text>
      </Box>
    </Box>
  );
}
