import type { ServerResponse } from "node:http";

export interface SseWriter {
  send(event: string, data: unknown, id?: number): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
}

export function sseResponse(res: ServerResponse): SseWriter {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const socket = res.socket;
  if (socket && "setNoDelay" in socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }

  res.flushHeaders?.();
  res.write(": ok\n\n");

  let closed = false;
  const safeWrite = (chunk: string): void => {
    if (closed) return;
    try {
      res.write(chunk);
    } catch {
      closed = true;
    }
  };

  return {
    send(event, data, id) {
      let frame = "";
      if (id !== undefined) frame += `id: ${id}\n`;
      frame += `event: ${event}\n`;
      frame += `data: ${JSON.stringify(data)}\n\n`;
      safeWrite(frame);
    },
    comment(text) {
      safeWrite(`: ${text}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        res.end();
      } catch {
        // ignore
      }
    },
    get closed() {
      return closed;
    },
  };
}
