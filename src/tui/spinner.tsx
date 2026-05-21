import { Text } from "ink";
import type { ReactElement } from "react";
import type { StatusGlyphs } from "./glyphs.js";

export interface SpinnerProps {
  tick: number;
  glyphs: StatusGlyphs;
  color?: string;
}

export function Spinner({ tick, glyphs, color = "yellow" }: SpinnerProps): ReactElement {
  const frames = glyphs.spinnerFrames;
  const idx = ((tick % frames.length) + frames.length) % frames.length;
  const frame = frames[idx] ?? frames[0] ?? "*";
  return <Text color={color}>{frame}</Text>;
}
