import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FailedRunEntry, appendFailedRun, readFailedRuns } from "./journal.js";

describe("failed-runs journal", () => {
  let savedHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    home = await mkdtemp(path.join(tmpdir(), "minifac-journal-"));
    process.env.MINIFAC_HOME = home;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  function sampleEntry(suffix: string | number): FailedRunEntry {
    return {
      worktreeDir: `/wt/${suffix}`,
      status: "failed",
      endedAt: new Date().toISOString(),
      reason: `reason-${suffix}`,
    };
  }

  it("missing file reads as empty", async () => {
    expect(await readFailedRuns()).toEqual([]);
  });

  it("appendFailedRun creates the file on first write", async () => {
    await appendFailedRun(sampleEntry(1));
    const entries = await readFailedRuns();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.worktreeDir).toBe("/wt/1");
  });

  it("appendFailedRun preserves prior entries", async () => {
    await appendFailedRun(sampleEntry(1));
    await appendFailedRun(sampleEntry(2));
    const entries = await readFailedRuns();
    expect(entries.map((e) => e.worktreeDir)).toEqual(["/wt/1", "/wt/2"]);
  });

  it("trims to 1000 entries on append", async () => {
    // Hand-seed a 1000-entry file to skip the slow 1000-append loop.
    const seeded: FailedRunEntry[] = [];
    for (let i = 0; i < 1000; i++) seeded.push(sampleEntry(i));
    await writeFile(path.join(home, "failed-runs.json"), JSON.stringify({ entries: seeded }));
    await appendFailedRun(sampleEntry("new"));
    const entries = await readFailedRuns();
    expect(entries).toHaveLength(1000);
    expect(entries[entries.length - 1]?.reason).toBe("reason-new");
    // Head-trimmed: the oldest entry should be gone.
    expect(entries[0]?.worktreeDir).toBe("/wt/1");
  });

  it("unreadable JSON reads as empty without throwing", async () => {
    await writeFile(path.join(home, "failed-runs.json"), "not json {{{");
    expect(await readFailedRuns()).toEqual([]);
  });
});
