import type { EmittedEvent } from "../executor/types.js";

export type RenderedEventKind =
  | "text"
  | "tool_use"
  | "tool_result"
  | "status"
  | "rate_limit"
  | "result"
  | "raw"
  | "system_init";

export interface RenderedEvent {
  kind: RenderedEventKind;
  summary: string;
  /** Pretty-printed full JSON. Present when the source was JSON. */
  fullJson?: string;
  /** Suppressed events still flow into the log but are hidden by default. */
  suppressed?: boolean;
  /** Highlight indicates the line should be drawn in an attention color. */
  highlight?: "rejected" | "status" | "result-failed" | "result-succeeded";
  /** The unparsed NodeEvent — present on synthetic / raw entries. */
  rawNodeEvent?: EmittedEvent["event"];
}

const SHORT_LIMIT = 80;

export function shortenOneLine(text: string, limit = SHORT_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Render a single stream-json line produced by an executor child.
 */
export function renderStreamJsonLine(line: string): RenderedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "raw", summary: shortenOneLine(line) };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "raw", summary: shortenOneLine(line), fullJson: pretty(parsed) };
  }
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? (obj.type as string) : undefined;
  const subtype = typeof obj.subtype === "string" ? (obj.subtype as string) : undefined;
  const fullJson = pretty(obj);

  if (type === "system" && subtype === "init") {
    return { kind: "system_init", summary: "system init", suppressed: true, fullJson };
  }
  if (type === "rate_limit_event" || subtype === "rate_limit_event") {
    const status = (obj.status ?? (obj.message as Record<string, unknown>)?.status) as
      | string
      | undefined;
    if (status === "rejected") {
      const reason =
        (typeof obj.reason === "string" && obj.reason) ||
        (typeof obj.message === "string" && obj.message) ||
        "rate limit rejected";
      return {
        kind: "rate_limit",
        summary: `rate limit rejected: ${shortenOneLine(String(reason))}`,
        highlight: "rejected",
        fullJson,
      };
    }
    return {
      kind: "rate_limit",
      summary: `rate limit (${status ?? "allowed"})`,
      suppressed: true,
      fullJson,
    };
  }

  if (type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content)
      ? (message.content as unknown[])
      : Array.isArray(obj.content)
        ? (obj.content as unknown[])
        : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" || b.type === "tool_call") {
        const name = typeof b.name === "string" ? b.name : "tool";
        const input = b.input ?? b.arguments ?? {};
        const args = compact(input);
        const summary = shortenOneLine(`→ ${name}(${args})`);
        return { kind: "tool_use", summary, fullJson };
      }
      if (b.type === "text" && typeof b.text === "string") {
        return { kind: "text", summary: shortenOneLine(b.text), fullJson };
      }
    }
    // Fallback for assistant lines with no recognizable block.
    if (typeof obj.text === "string") {
      return { kind: "text", summary: shortenOneLine(obj.text), fullJson };
    }
    return { kind: "text", summary: "(assistant)", fullJson };
  }

  if (type === "user") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content)
      ? (message.content as unknown[])
      : Array.isArray(obj.content)
        ? (obj.content as unknown[])
        : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        const isError = b.is_error === true;
        const raw = b.content;
        let resultText: string;
        if (typeof raw === "string") {
          resultText = raw;
        } else if (Array.isArray(raw)) {
          const firstText = raw.find(
            (x) =>
              x &&
              typeof x === "object" &&
              (x as Record<string, unknown>).type === "text" &&
              typeof (x as Record<string, unknown>).text === "string",
          ) as Record<string, unknown> | undefined;
          resultText = firstText ? (firstText.text as string) : compact(raw);
        } else {
          resultText = compact(raw);
        }
        const firstLine = resultText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
        const glyph = isError ? "✗" : "✓";
        return {
          kind: "tool_result",
          summary: shortenOneLine(`${glyph} ${firstLine}`),
          fullJson,
        };
      }
    }
    return { kind: "raw", summary: shortenOneLine(line), fullJson };
  }

  if (type === "result") {
    const status = typeof obj.subtype === "string" ? obj.subtype : undefined;
    const isError = obj.is_error === true || status === "error";
    const reason =
      (typeof obj.result === "string" && obj.result) ||
      (typeof obj.error === "string" && obj.error) ||
      "";
    const summary = isError
      ? shortenOneLine(`result: error${reason ? ` — ${reason}` : ""}`)
      : shortenOneLine(`result: ${status ?? "success"}${reason ? ` — ${reason}` : ""}`);
    return {
      kind: "result",
      summary,
      highlight: isError ? "result-failed" : "result-succeeded",
      fullJson,
    };
  }

  return { kind: "raw", summary: shortenOneLine(line), fullJson };
}

/**
 * Render a runner-emitted NodeEvent (stdout / stderr / synthetic status).
 *
 * - stdout: parse as stream-json line.
 * - stderr: rendered as a raw line.
 * - status: rendered as a synthetic highlighted line.
 */
export function renderNodeEvent(entry: EmittedEvent): RenderedEvent {
  const e = entry.event;
  if (e.kind === "stdout") {
    const rendered = renderStreamJsonLine(e.line);
    return { ...rendered, rawNodeEvent: e };
  }
  if (e.kind === "stderr") {
    return {
      kind: "raw",
      summary: shortenOneLine(e.line),
      rawNodeEvent: e,
    };
  }
  // status
  return {
    kind: "status",
    summary: `${entry.nodeId} iter=${entry.iteration}: ${e.status}`,
    highlight: "status",
    rawNodeEvent: e,
  };
}
