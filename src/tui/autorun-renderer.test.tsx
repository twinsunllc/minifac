import { describe, expect, it, vi } from "vitest";
import { createInkAutorunRenderer } from "./autorun-renderer.js";

function makeStdout(opts: { isTTY?: boolean } = {}) {
  return Object.assign(new (require("node:stream").Writable)(), {
    isTTY: opts.isTTY ?? false,
    columns: 100,
    rows: 30,
    // biome-ignore lint/suspicious/noExplicitAny: stream signature
    _write(_c: any, _e: BufferEncoding, cb: () => void) {
      cb();
    },
  });
}

describe("createInkAutorunRenderer", () => {
  it("renders into the provided stdout and resolves on programmatic raw-switch", async () => {
    const stdout = Object.assign(new (require("node:stream").Writable)(), {
      isTTY: false,
      columns: 80,
      rows: 24,
      // biome-ignore lint/suspicious/noExplicitAny: stream signature
      _write(_c: any, _e: BufferEncoding, cb: () => void) {
        cb();
      },
    });
    const renderer = createInkAutorunRenderer({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: { LANG: "C" },
    });
    renderer.requestRawSwitch();
    const exit = await renderer.waitForExit();
    expect(exit.action).toBe("raw-switch");
    expect(exit.exitCode).toBe(0);
  });

  it("q with no in-flight runs resolves with action=quit and exitCode=0", async () => {
    const stdout = Object.assign(new (require("node:stream").Writable)(), {
      isTTY: false,
      columns: 80,
      rows: 24,
      // biome-ignore lint/suspicious/noExplicitAny: stream signature
      _write(_c: any, _e: BufferEncoding, cb: () => void) {
        cb();
      },
    });
    const onQuitRequested = vi.fn();
    const renderer = createInkAutorunRenderer({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: { LANG: "C" },
      getInFlight: () => 0,
      onQuitRequested,
    });
    renderer.requestQuit();
    const exit = await renderer.waitForExit();
    expect(exit.action).toBe("quit");
    expect(exit.exitCode).toBe(0);
    expect(onQuitRequested).toHaveBeenCalled();
  });

  it("q with in-flight runs stays mounted; a second q escalates and exits 2", async () => {
    const stdout = Object.assign(new (require("node:stream").Writable)(), {
      isTTY: false,
      columns: 80,
      rows: 24,
      // biome-ignore lint/suspicious/noExplicitAny: stream signature
      _write(_c: any, _e: BufferEncoding, cb: () => void) {
        cb();
      },
    });
    const onQuitRequested = vi.fn();
    const renderer = createInkAutorunRenderer({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: { LANG: "C" },
      getInFlight: () => 1,
      onQuitRequested,
    });
    // First press: drain initiated, stays mounted.
    renderer.requestQuit();
    let resolved = false;
    renderer.waitForExit().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    expect(onQuitRequested).toHaveBeenCalledTimes(1);

    // Second press: escalate.
    renderer.requestQuit();
    const exit = await renderer.waitForExit();
    expect(exit.action).toBe("quit");
    expect(exit.exitCode).toBe(2);
    expect(onQuitRequested).toHaveBeenCalledTimes(2);
  });

  it("advances the embedded RunState.tick while a node is running", async () => {
    const stdout = makeStdout({ isTTY: true });
    const { PassThrough } = require("node:stream") as typeof import("node:stream");
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
    });
    const renderer = createInkAutorunRenderer({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      env: { LANG: "C" },
      resolveRunInit: (change) => ({
        brief: { change },
        factory: { name: "sdd" },
        nodeIds: ["propose"],
      }),
    });

    // Wait for ink to commit the initial mount so bridgeRef is bound.
    await new Promise((r) => setTimeout(r, 50));

    // Seed a brief with a runState whose only node is in "running".
    renderer.onEvent({ kind: "started", ts: 0, change: "foo" });
    renderer.onRunEvent("foo", {
      nodeId: "propose",
      iteration: 1,
      emittedAt: 0,
      event: { kind: "stdout", line: '{"type":"system","subtype":"init"}' },
    });

    // Let React commit the pending state updates before reading the snapshot.
    await new Promise((r) => setTimeout(r, 50));

    // The renderer's selectedBriefIndex defaults to 0 — the brief we just
    // started — so the tick guard's "selected brief has a running node"
    // condition is satisfied.
    const seeded = renderer.snapshot().briefs[0]?.runState;
    expect(seeded).toBeDefined();
    expect(seeded?.nodes.find((n) => n.id === "propose")?.status).toBe("running");
    const before = seeded?.tick ?? 0;

    // Wait ~300ms of real time so the 100ms tick loop fires several times.
    await new Promise((r) => setTimeout(r, 320));

    const after = renderer.snapshot().briefs[0]?.runState?.tick ?? 0;
    expect(after).toBeGreaterThan(before);

    renderer.unmount();
  });
});
