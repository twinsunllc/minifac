import { describe, expect, it } from "vitest";
import { type MissingOutput, buildNudgeMessage } from "./nudge.js";

describe("buildNudgeMessage", () => {
  it("renders a single missing value output with no detail", () => {
    const out = buildNudgeMessage([
      {
        key: "findings",
        type: "value",
        expected_path: "/tmp/outputs/n1/1/findings.json",
      },
    ]);
    expect(out).toContain("The following declared required outputs were not produced:");
    expect(out).toContain(
      "- findings (type: value): expected at /tmp/outputs/n1/1/findings.json",
    );
    expect(out).toContain("Please produce these outputs now.");
    expect(out).toContain("MINIFAC_STATUS: succeeded");
    expect(out).toContain("MINIFAC_STATUS: failed");
    expect(out).toContain("REASON");
  });

  it("renders multiple missing outputs as separate bullets in order", () => {
    const out = buildNudgeMessage([
      {
        key: "findings",
        type: "value",
        expected_path: "/tmp/outputs/n/1/findings.json",
      },
      {
        key: "report",
        type: "file",
        expected_path: "/tmp/outputs/n/1/report.md",
      },
    ]);
    const findingsIdx = out.indexOf("findings");
    const reportIdx = out.indexOf("report");
    expect(findingsIdx).toBeGreaterThan(0);
    expect(reportIdx).toBeGreaterThan(findingsIdx);
  });

  it("renders all three output types in one list", () => {
    const out = buildNudgeMessage([
      { key: "findings", type: "value", expected_path: "/tmp/findings.json" },
      { key: "report", type: "file", expected_path: "/tmp/report.md" },
      { key: "logs", type: "directory", expected_path: "/tmp/logs" },
    ]);
    expect(out).toMatch(/findings .*type: value/);
    expect(out).toMatch(/report .*type: file/);
    expect(out).toMatch(/logs .*type: directory/);
  });

  it("includes non-trivial detail strings as a suffix on the bullet", () => {
    const out = buildNudgeMessage([
      {
        key: "findings",
        type: "value",
        expected_path: "/tmp/findings.json",
        detail: "parse error: unexpected end of input",
      },
    ]);
    expect(out).toContain("parse error: unexpected end of input");
  });

  it("collapses trivial 'absent' detail to the bare bullet (no suffix)", () => {
    const out = buildNudgeMessage([
      {
        key: "findings",
        type: "value",
        expected_path: "/tmp/findings.json",
        detail: "absent",
      },
    ]);
    expect(out).not.toContain("absent");
    expect(out).toContain("- findings (type: value): expected at /tmp/findings.json");
  });

  it("includes the ambiguous detail string when present", () => {
    const out = buildNudgeMessage([
      {
        key: "report",
        type: "file",
        expected_path: "/tmp/outputs",
        detail: "ambiguous: matched 2 files: report.md, report.txt",
      },
    ]);
    expect(out).toContain("ambiguous");
  });

  it("includes the empty-directory detail string when present", () => {
    const out = buildNudgeMessage([
      {
        key: "logs",
        type: "directory",
        expected_path: "/tmp/logs",
        detail: "empty",
      },
    ]);
    expect(out).toContain("empty");
  });

  it("includes the canonical header line", () => {
    const items: MissingOutput[] = [
      { key: "a", type: "value", expected_path: "/x/a.json" },
    ];
    const out = buildNudgeMessage(items);
    expect(out.split("\n")[0]).toBe(
      "The following declared required outputs were not produced:",
    );
  });
});
