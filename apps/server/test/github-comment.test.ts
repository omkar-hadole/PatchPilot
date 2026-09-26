import { describe, expect, it } from "vitest";
import { buildGitHubStatusComment } from "../src/server.js";

function record(status: string, result?: Record<string, unknown>, safeToExecute = status !== "security-review") {
  return {
    repository: "owner/repo",
    baseBranch: "main",
    issueTitle: "Tokenizer mishandles escaped uppercase literals",
    issueBody: "\\A becomes a.",
    dashboardUrl: "https://byter.test/runs/run-25",
    run: { id: "run-25", status, issue: { owner: "owner", repo: "repo", issueNumber: 25 } },
    scan: { safeToExecute, findings: safeToExecute ? [] : [{ ruleId: "shell-command", severity: "high", reason: "Unsafe command", matchedText: "rm -rf /" }] },
    trueForge: { status: ["triaging", "environment-building", "reproducing"].includes(status) ? "started" : "completed", session: { id: "session-25" }, result }
  } as any;
}

const patch = {
  title: "Preserve escaped literal case",
  body: "Keep escaped characters unchanged.",
  files: [{ path: "src/tokenizer.ts", content: "secret should stay on the dashboard" }],
  hash: "a".repeat(64),
  baseBranch: "main",
  branchName: "byter/fix-25",
  verifiedAt: "2026-08-30T00:00:00.000Z"
};

describe("GitHub status comment rendering", () => {
  it.each([
    ["triaging", "Investigating", "TrueForge is inspecting"],
    ["environment-building", "Environment building", "preparing an isolated environment"],
    ["reproducing", "Reproducing", "running the reported scenario"],
    ["needs-info", "Needs information", "Add the missing runtime"],
    ["not-reproduced", "Not reproduced", "did not observe the claimed failure"],
    ["verified", "Verified", "No candidate patch was returned"],
    ["security-review", "Security review", "Execution was held"],
    ["awaiting-approval", "Patch ready for review", "TrueForge is paused"],
    ["pr-created", "Fix proposed", "Draft PR created"],
    ["failed", "Run failed", "complete proof-and-approval contract"]
  ])("renders the %s state as a concise status comment", (status, label, stateText) => {
    const verifiedResult = {
      status: "verified",
      summary: "The failure was reproduced, but no automatic patch was proposed.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "3/3 passed", attempts: "3/3" }
    };
    const patchResult = {
      status: "patch-ready",
      summary: "The failure was reproduced.",
      rootCauseSummary: "The escape branch changes the literal case.",
      proposedFixSummary: "Preserve the escaped character before writing the patch.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "3/3 passed", attempts: "3/3" },
      candidatePatch: patch,
      ...(status === "pr-created" ? { pullRequest: { number: 42, url: "https://github.test/pull/42" } } : {})
    };
    const body = buildGitHubStatusComment(record(
      status,
      status === "verified" ? verifiedResult : status === "failed" || ["triaging", "environment-building", "reproducing", "needs-info", "not-reproduced", "security-review"].includes(status) ? undefined : patchResult,
      status === "security-review" ? false : true
    ), status === "triaging" ? "started" : status === "failed" ? "failed" : status === "pr-created" ? "approval" : "completed");
    expect(body).toContain(`## Byter · ${label}`);
    expect(body).toContain("Issue #25");
    expect(body).toContain(stateText);
    expect(body.length).toBeLessThan(2_000);
    expect(body).not.toContain("secret should stay on the dashboard");
    expect(body).not.toContain("/byter approve");
  });

  it("puts the direct review CTA on the paused patch state", () => {
    const body = buildGitHubStatusComment(record("awaiting-approval", {
      status: "patch-ready",
      summary: "The failure was reproduced.",
      rootCauseSummary: "The escape branch changes the literal case.",
      proposedFixSummary: "Preserve the escaped character.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "3/3 passed", attempts: "3/3" },
      candidatePatch: patch
    }), "completed");
    expect(body).toContain("https://byter.test/runs/run-25/review");
    expect(body).toContain("TrueForge is paused");
    expect(body).not.toContain("Technical details");
    expect(body).not.toContain("session-25");
    expect(body).not.toContain(patch.hash);
    expect(body).not.toContain("Base branch");
  });

  it("keeps long evidence readable without cutting the final word", () => {
    const body = buildGitHubStatusComment(record("awaiting-approval", {
      status: "patch-ready",
      summary: "The failure was reproduced.",
      rootCauseSummary: "The escape branch changes the literal case.",
      proposedFixSummary: "Preserve the escaped character.",
      proof: {
        before: `The reproducer returned the incorrect lowercase token because ${"additional context ".repeat(30)}`,
        after: "The same reproducer returned the expected uppercase token.",
        regressions: "The focused and existing suites passed.",
        attempts: "3/3 matching failures"
      },
      candidatePatch: patch
    }), "completed");

    expect(body).toContain("- **Before:**");
    expect(body).toContain("- **After:**");
    expect(body).not.toContain("| Before / after |");
    expect(body).toMatch(/- \*\*Before:\*\* [^\n]+\.\.\./);
    expect(body).not.toMatch(/con\.\.\./);
  });
});
