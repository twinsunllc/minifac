import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// SCARIFW-2125: bearer.yml has installed Bearer from one release tarball,
// checked with `sha256sum -c` against a hard-coded sha256 before it is
// extracted, since SCARIFW-1550 (docs/decisions/0047-Bearer-SAST-PR-Gate.md),
// rather than through bearer/bearer-action, which pipes install.sh from
// Bearer/bearer's main branch into sh and installs whatever CLI is latest.
// Nothing enforced that. These tests fail on an unpinned Bearer install
// anywhere in .github/workflows.
//
// findUnpinnedBearerInstalls() is a text check over a workflow file. It flags
// bearer/bearer-action, a downloaded script piped into a shell, a fetch of
// Bearer's install.sh, the `latest` release, a package-manager install, and a
// Bearer image without a digest. A file that downloads a Bearer release
// tarball must also follow the form bearer.yml uses: an exact x.y.z
// BEARER_VERSION, a 64-hex BEARER_SHA256, a download URL under
// /releases/download/v${BEARER_VERSION}/, and a `sha256sum -c` of
// BEARER_SHA256 ahead of any `tar -x`. The negative fixtures below show each
// rule reds.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const BEARER_PATH = join(WORKFLOWS_DIR, "bearer.yml");
const ACTION_SECURITY_PATH = join(WORKFLOWS_DIR, "action-security.yml");

/** Comment lines dropped and backslash-continued lines joined, so a rule sees one command per line. */
function executableText(text: string): string {
  return text
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const UNPINNED_RULES: { pattern: RegExp; message: string }[] = [
  {
    pattern: /^\s*(?:-\s*)?uses:\s*["']?bearer\/bearer-action\b/im,
    message: "uses bearer/bearer-action, which pipes install.sh from Bearer/bearer main into sh",
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
    message: "pipes a downloaded script into a shell",
  },
  {
    pattern: /\b(?:ba|z|da)?sh\b[^\n]*(?:<\(|\$\()\s*(?:curl|wget)\b/i,
    message: "runs a downloaded script through a shell",
  },
  {
    pattern: /bearer[^\s"']*\/install\.sh|raw\.githubusercontent\.com\/bearer\//i,
    message: "fetches Bearer's install.sh",
  },
  {
    pattern: /bearer\/bearer\/releases\/latest\b/i,
    message: "downloads Bearer's latest release rather than a pinned version",
  },
  {
    pattern: /\b(?:brew|apt|apt-get|go)\s+install\b[^\n]*\bbearer\b/i,
    message: "installs Bearer from a package manager, unpinned",
  },
  {
    pattern:
      /(?:docker:\/\/|docker\s+(?:run|pull)\b[^\n]*\s|image:\s*["']?)bearer\/bearer(?![\w.:/-]*@sha256:[0-9a-f]{64})/i,
    message: "runs a Bearer container image that is not pinned by digest",
  },
];

function releaseInstallViolations(text: string): string[] {
  const urls = [...text.matchAll(/bearer\/bearer\/releases\/download\/([^/\s"']+)\//gi)];
  if (urls.length === 0) return [];

  const violations: string[] = [];
  const version = /^\s*BEARER_VERSION:\s*["']?([^"'\s]+)/m.exec(text)?.[1];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    violations.push(`BEARER_VERSION is ${version ?? "not set"}, not an exact x.y.z release`);
  }
  const sha = /^\s*BEARER_SHA256:\s*["']?([^"'\s]+)/m.exec(text)?.[1];
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
    violations.push(`BEARER_SHA256 is ${sha ?? "not set"}, not a 64-hex sha256`);
  }
  for (const [, tag = ""] of urls) {
    if (!/^v\$\{\{?\s*(?:env\.)?BEARER_VERSION\s*\}?\}$/.test(tag)) {
      violations.push(`downloads release ${tag}, not v\${BEARER_VERSION}`);
    }
  }
  const checkAt = text.search(
    /^[^\n]*\bBEARER_SHA256\b[^\n]*\bsha256sum\s+(?:--strict\s+)?(?:-c|--check)\b/m,
  );
  if (checkAt < 0) {
    violations.push("never checks the tarball with `sha256sum -c` against BEARER_SHA256");
  }
  const tarAt = text.search(/\btar\s+-?[a-zA-Z]*x/);
  if (tarAt >= 0 && checkAt >= 0 && tarAt < checkAt) {
    violations.push("extracts the tarball before checking its sha256");
  }
  return violations;
}

/** Every way `text` (a workflow file) installs Bearer unpinned; empty when it installs it pinned or not at all. */
function findUnpinnedBearerInstalls(text: string): string[] {
  const code = executableText(text);
  return [
    ...UNPINNED_RULES.filter(({ pattern }) => pattern.test(code)).map(({ message }) => message),
    ...releaseInstallViolations(code),
  ];
}

function hasPinnedReleaseInstall(text: string): boolean {
  return (
    /bearer\/bearer\/releases\/download\//i.test(text) &&
    findUnpinnedBearerInstalls(text).length === 0
  );
}

const PINNED_FIXTURE = `
jobs:
  bearer:
    runs-on: ubuntu-latest
    env:
      BEARER_VERSION: "2.1.1"
      BEARER_SHA256: "6b79d315577fea8305dfe08577bea6ad53852a929cd24de9211d39750a194bbb"
    steps:
      - name: Install Bearer CLI
        run: |
          set -euo pipefail
          tarball="bearer_\${BEARER_VERSION}_linux_amd64.tar.gz"
          curl -fsSL --retry 3 -o "$RUNNER_TEMP/$tarball" \\
            "https://github.com/Bearer/bearer/releases/download/v\${BEARER_VERSION}/\${tarball}"
          echo "\${BEARER_SHA256}  $RUNNER_TEMP/$tarball" | sha256sum -c -
          tar -xzf "$RUNNER_TEMP/$tarball" -C "$RUNNER_TEMP" bearer
`;

function stepsFixture(steps: string): string {
  return `jobs:\n  bearer:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
}

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; [key: string]: unknown };
type Job = { steps: Step[]; [key: string]: unknown };

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
const bearerWorkflow = parse(readFileSync(BEARER_PATH, "utf8")) as {
  env?: Record<string, string>;
  jobs: { bearer: Job };
};
const bearerJob = bearerWorkflow.jobs.bearer;
const actionSecurity = parse(readFileSync(ACTION_SECURITY_PATH, "utf8")) as {
  jobs: { "audit-actions": Job };
};

describe("no workflow installs Bearer unpinned (AC-1, AC-2)", () => {
  it("reads at least the bearer workflow", () => {
    expect(workflowFiles).toContain("bearer.yml");
  });

  it.each(workflowFiles)("%s has no unpinned Bearer install", (file) => {
    expect(findUnpinnedBearerInstalls(readFileSync(join(WORKFLOWS_DIR, file), "utf8"))).toEqual([]);
  });
});

describe("the checker reds on an unpinned install (AC-6)", () => {
  it("accepts the pinned, sha256-verified install", () => {
    expect(findUnpinnedBearerInstalls(PINNED_FIXTURE)).toEqual([]);
    expect(hasPinnedReleaseInstall(PINNED_FIXTURE)).toBe(true);
  });

  it("ignores bearer-action and install.sh named only in a comment", () => {
    const commented = `# not bearer/bearer-action: it pipes\n# raw.githubusercontent.com/Bearer/bearer/main/contrib/install.sh | sh\n${PINNED_FIXTURE}`;
    expect(findUnpinnedBearerInstalls(commented)).toEqual([]);
  });

  const cases: [string, string, string][] = [
    [
      "bearer/bearer-action pinned by sha",
      stepsFixture(
        "      - uses: bearer/bearer-action@828eeb928ce2f4a7ca5ed57fb8b59508cb8c79bc # v2\n        with:\n          scanner: sast\n",
      ),
      "uses bearer/bearer-action",
    ],
    [
      "bearer/bearer-action by tag",
      stepsFixture('      - name: Bearer\n        uses: "Bearer/bearer-action@v2"\n'),
      "uses bearer/bearer-action",
    ],
    [
      "install.sh piped into sh",
      stepsFixture(
        "      - run: curl -sfL https://raw.githubusercontent.com/Bearer/bearer/main/contrib/install.sh | sh -s -- -b /usr/local/bin\n",
      ),
      "pipes a downloaded script into a shell",
    ],
    [
      "install.sh downloaded, then run",
      stepsFixture(
        "      - run: |\n          curl -fsSLo install.sh https://raw.githubusercontent.com/Bearer/bearer/main/contrib/install.sh\n          sh install.sh\n",
      ),
      "fetches Bearer's install.sh",
    ],
    [
      "a script piped into bash across a line continuation",
      stepsFixture(
        "      - run: |\n          wget -qO- https://example.com/get-bearer \\\n            | sudo bash\n",
      ),
      "pipes a downloaded script into a shell",
    ],
    [
      "a script run through bash <(curl …)",
      stepsFixture("      - run: bash <(curl -fsSL https://example.com/get-bearer)\n"),
      "runs a downloaded script through a shell",
    ],
    [
      "the latest release",
      stepsFixture(
        "      - run: curl -fsSLO https://github.com/Bearer/bearer/releases/latest/download/bearer_linux_amd64.tar.gz\n",
      ),
      "downloads Bearer's latest release",
    ],
    [
      "brew install",
      stepsFixture("      - run: brew install bearer/tap/bearer\n"),
      "package manager",
    ],
    [
      "a container image by tag",
      stepsFixture(
        '      - run: docker run --rm -v "$PWD:/tmp/scan" bearer/bearer:latest scan /tmp/scan\n',
      ),
      "not pinned by digest",
    ],
    [
      "BEARER_VERSION: latest",
      PINNED_FIXTURE.replace('BEARER_VERSION: "2.1.1"', 'BEARER_VERSION: "latest"'),
      "BEARER_VERSION is latest",
    ],
    [
      "a version range",
      PINNED_FIXTURE.replace('BEARER_VERSION: "2.1.1"', 'BEARER_VERSION: "2.1"'),
      "BEARER_VERSION is 2.1",
    ],
    [
      "no BEARER_SHA256",
      PINNED_FIXTURE.replace(/^\s*BEARER_SHA256:.*$/m, ""),
      "BEARER_SHA256 is not set",
    ],
    [
      "a truncated sha256",
      PINNED_FIXTURE.replace(
        "6b79d315577fea8305dfe08577bea6ad53852a929cd24de9211d39750a194bbb",
        "6b79d315",
      ),
      "BEARER_SHA256 is 6b79d315",
    ],
    [
      "a tarball install with no sha256sum",
      PINNED_FIXTURE.replace(/^.*sha256sum.*$/m, ""),
      "never checks the tarball",
    ],
    [
      "sha256sum present but not run against BEARER_SHA256",
      PINNED_FIXTURE.replace(/^.*sha256sum.*$/m, '          sha256sum "$RUNNER_TEMP/$tarball"'),
      "never checks the tarball",
    ],
    [
      "extraction before verification",
      PINNED_FIXTURE.replace(
        /^(.*sha256sum.*)\n(.*tar -xzf.*)$/m,
        (_m, check: string, tar: string) => `${tar}\n${check}`,
      ),
      "extracts the tarball before checking its sha256",
    ],
    [
      "a download URL not built from BEARER_VERSION",
      PINNED_FIXTURE.replace("download/v${BEARER_VERSION}/", "download/v2.0.2/"),
      "downloads release v2.0.2",
    ],
  ];

  it.each(cases)("reds on %s", (_name, fixture, expected) => {
    const violations = findUnpinnedBearerInstalls(fixture);
    expect(
      violations.some((v) => v.includes(expected)),
      violations.join("\n"),
    ).toBe(true);
    expect(hasPinnedReleaseInstall(fixture)).toBe(false);
  });
});

describe("bearer.yml bearer job (AC-3, AC-7, AC-8)", () => {
  const runs = bearerJob.steps.map((s) => s.run ?? "").join("\n");

  it("installs Bearer from the pinned, sha256-verified release", () => {
    const env = { ...bearerWorkflow.env, ...(bearerJob.env as Record<string, string> | undefined) };
    expect(env.BEARER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(env.BEARER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(hasPinnedReleaseInstall(readFileSync(BEARER_PATH, "utf8"))).toBe(true);
    expect(runs).toContain("/releases/download/v${BEARER_VERSION}/");
    expect(runs.indexOf("sha256sum -c")).toBeGreaterThan(-1);
    expect(runs.indexOf("sha256sum -c")).toBeLessThan(runs.indexOf("tar -xzf"));
  });

  it("uses no third-party action besides the pinned checkout", () => {
    const uses = bearerJob.steps.flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
  });

  it("scans sast,secrets at critical,high", () => {
    const scan = bearerJob.steps.find((s) => /\bbearer"? scan\b/.test(s.run ?? ""));
    expect(scan?.run).toMatch(/--scanner sast,secrets\b/);
    expect(scan?.run).toMatch(/--severity critical,high(?![,\w])/);
  });

  it("stays failure-blocking: no continue-on-error on the job or any step", () => {
    expect(bearerJob).not.toHaveProperty("continue-on-error");
    for (const step of bearerJob.steps) expect(step).not.toHaveProperty("continue-on-error");
  });

  it("checks out without persisting credentials", () => {
    const checkout = bearerJob.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("gives no step a token or secret", () => {
    expect(JSON.stringify(bearerJob)).not.toMatch(/GITHUB_TOKEN|github\.token|secrets\./);
    expect(JSON.stringify(bearerWorkflow.env ?? {})).not.toMatch(
      /GITHUB_TOKEN|github\.token|secrets\./,
    );
  });
});

describe("action-security allowlist (AC-9)", () => {
  it("does not trust the bearer publisher", () => {
    const audit = actionSecurity.jobs["audit-actions"].steps.find((s) =>
      s.uses?.startsWith("twinsunllc/github-actions-security-checker@"),
    );
    const allowlist = String(audit?.with?.allowlist ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(allowlist).toContain("twinsunllc");
    expect(allowlist).not.toContain("bearer");
  });
});
