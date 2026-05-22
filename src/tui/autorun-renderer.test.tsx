import { describe, expect, it, vi } from "vitest";
import { createInkAutorunRenderer } from "./autorun-renderer.js";

describe("createInkAutorunRenderer", () => {
  it("renders into the provided stdout and resolves on programmatic raw-switch", async () => {
    const stdout = Object.assign(new (require("stream").Writable)(), {
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
    const stdout = Object.assign(new (require("stream").Writable)(), {
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
    const stdout = Object.assign(new (require("stream").Writable)(), {
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
});
