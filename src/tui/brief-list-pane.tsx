import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { BriefListState, BriefRowState, BriefStatus } from "./autorun-reducer.js";
import type { StatusGlyphs } from "./glyphs.js";
import { Spinner } from "./spinner.js";

export interface BriefListPaneProps {
  state: BriefListState;
  glyphs: StatusGlyphs;
  width?: number;
}

function colorFor(status: BriefStatus): string | undefined {
  switch (status) {
    case "queued":
      return "gray";
    case "running":
      return "yellow";
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "skipped":
      return "gray";
  }
}

function glyphFor(glyphs: StatusGlyphs, status: BriefStatus): string {
  switch (status) {
    case "queued":
      return glyphs.pending;
    case "running":
      return glyphs.running;
    case "succeeded":
      return glyphs.succeeded;
    case "failed":
      return glyphs.failed;
    case "skipped":
      return glyphs.skipped;
  }
}

function suffixFor(row: BriefRowState): string {
  if (row.status === "skipped" && row.skipReason) return ` (${row.skipReason})`;
  if (row.runId) return ` ${row.runId.slice(0, 6)}`;
  return "";
}

function BriefRow({
  row,
  selected,
  glyphs,
  tick,
  focused,
}: {
  row: BriefRowState;
  selected: boolean;
  glyphs: StatusGlyphs;
  tick: number;
  focused: boolean;
}): ReactElement {
  const color = colorFor(row.status);
  const marker = selected ? (focused ? "▸ " : "· ") : "  ";
  const isRunning = row.status === "running";
  return (
    <Box>
      <Text>{marker}</Text>
      {isRunning ? (
        <Spinner tick={tick} glyphs={glyphs} color={color} />
      ) : (
        <Text color={color}>{glyphFor(glyphs, row.status)}</Text>
      )}
      <Text> </Text>
      <Text color={color}>{row.change}</Text>
      <Text color="gray">{suffixFor(row)}</Text>
    </Box>
  );
}

export function BriefListPane({ state, glyphs }: BriefListPaneProps): ReactElement {
  if (state.briefs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">(no briefs yet)</Text>
      </Box>
    );
  }
  const focused = state.focus === "brief-list";
  return (
    <Box flexDirection="column">
      {state.briefs.map((row, idx) => (
        <BriefRow
          key={row.change}
          row={row}
          selected={idx === state.selectedBriefIndex}
          focused={focused}
          glyphs={glyphs}
          tick={state.tick}
        />
      ))}
    </Box>
  );
}
