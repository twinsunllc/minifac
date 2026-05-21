import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { RenderedEvent } from "./event-rendering.js";
import { type RunState, visibleEvents } from "./reducer.js";

function colorFor(event: RenderedEvent): string | undefined {
  if (event.highlight === "rejected") return "red";
  if (event.highlight === "result-failed") return "red";
  if (event.highlight === "result-succeeded") return "green";
  if (event.highlight === "status") return "cyan";
  if (event.kind === "tool_use") return "blue";
  if (event.kind === "tool_result") {
    return event.summary.startsWith("✗") ? "red" : "green";
  }
  if (event.kind === "raw") return "gray";
  return undefined;
}

function LogLine({
  event,
  highlighted,
  showDetails,
}: {
  event: RenderedEvent;
  highlighted: boolean;
  showDetails: boolean;
}): ReactElement {
  const color = colorFor(event);
  if (showDetails && event.fullJson) {
    return (
      <Box flexDirection="column">
        <Text color="magenta">{highlighted ? "▸ " : "  "}--- details ---</Text>
        {event.fullJson.split(/\n/).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable ordering
          <Text key={i} color="gray">
            {"  "}
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box>
      <Text color={highlighted ? "white" : color} bold={highlighted}>
        {highlighted ? "▸ " : "  "}
        {event.summary}
      </Text>
    </Box>
  );
}

export interface LogPaneProps {
  state: RunState;
  height?: number;
  /** Optional prefix shown on each block (single-pane fallback). */
  prefix?: string;
}

export function LogPane({ state, height, prefix }: LogPaneProps): ReactElement {
  const { events, nodeId, iteration } = visibleEvents(state);
  const limit = height ? Math.max(1, height - 1) : events.length;
  const start = Math.min(state.scrollOffset, Math.max(0, events.length - limit));
  const slice = events.slice(start, start + limit);
  return (
    <Box flexDirection="column">
      {prefix ? <Text color="cyan">{prefix}</Text> : null}
      {slice.length === 0 ? (
        <Text color="gray">
          (no events yet for {nodeId} iter {iteration})
        </Text>
      ) : (
        slice.map((event, i) => {
          const absoluteIndex = start + i;
          const key = `${state.selectedNodeId}|${iteration}|${absoluteIndex}`;
          return (
            <LogLine
              key={key}
              event={event}
              highlighted={absoluteIndex === state.highlightIndex}
              showDetails={state.detailsOpen.has(key)}
            />
          );
        })
      )}
    </Box>
  );
}
