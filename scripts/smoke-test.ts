// Real end-to-end smoke test for PatchPilotHarnessRuntime, bypassing the
// webhook/dashboard pipeline so a single run can be watched from the CLI.
//
// Requires real credentials in .env or the environment:
//   AI_API_KEY       - required
//   GITHUB_TOKEN      - required, needs repo scope on the target repository
//   SMOKE_OWNER       - GitHub owner, defaults to "omkar-hadole"
//   SMOKE_REPO        - GitHub repo, defaults to "PatchPilot"
//   SMOKE_ISSUE       - issue number to reproduce/fix, defaults to 1
//   SMOKE_BASE_BRANCH - defaults to "main"
//
// Run with: node --experimental-strip-types scripts/smoke-test.ts

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GitHubRestClient } from "@patchpilot/github";
import { PatchPilotHarnessRuntime, modelClientFromEnv } from "@patchpilot/agent";

// Auto-load root .env if present
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // ignore
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error(`Please set it in your .env file or environment.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const owner = process.env.SMOKE_OWNER ?? "omkar-hadole";
  const repo = process.env.SMOKE_REPO ?? "PatchPilot";
  const issueNumber = Number(process.env.SMOKE_ISSUE ?? "1");
  const baseBranch = process.env.SMOKE_BASE_BRANCH ?? "main";

  const model = modelClientFromEnv();
  if (!model) {
    console.error("AI_API_KEY is not set. Please set it in your .env file.");
    process.exit(1);
  }

  console.log(`Connecting to GitHub as client...`);
  const githubClient = new GitHubRestClient({ token: githubToken });

  console.log(`Fetching issue ${owner}/${repo}#${issueNumber}...`);
  const issue = await githubClient.getIssue(owner, repo, issueNumber);

  console.log(`\nStarting session for ${owner}/${repo}#${issueNumber}: ${issue.title}`);

  const runtime = new PatchPilotHarnessRuntime({
    githubClient,
    model,
    onEvent: (event) => {
      console.log(`[event] ${event.type}`, summarize(event.raw));
    }
  });

  const { session, turn } = await runtime.startSession({
    repository: `${owner}/${repo}`,
    issueUrl: issue.html_url,
    issueTitle: issue.title,
    issueBody: issue.body ?? "",
    baseBranch,
    branchName: `patchpilot/smoke-test-${issueNumber}-${Date.now()}`
  });

  console.log(`\nSession initialized: ${session.id} | Turn: ${turn.id} | Status: ${turn.status}`);

  let events = await runtime.listSessionEvents(session.id);
  const pendingApproval = () => events.find((event) => event.type === "tool.approval_required");

  while (pendingApproval() && !events.some((event) => event.type === "turn.done")) {
    const approvalEvent = pendingApproval()!;
    const raw = approvalEvent.raw as { toolCalls: Array<{ id: string; toolCallId: string }> };
    const toolCallId = raw.toolCalls[0]?.toolCallId ?? raw.toolCalls[0]?.id;
    console.log(`\nMaintainer approval required for write tool call ${toolCallId}.`);
    const decision = await promptYesNo("Approve this write? [y/N] ");
    const resumedTurn = await runtime.resolveToolApproval({
      sessionId: session.id,
      previousTurnId: turn.id,
      threadId: "main",
      toolCallId,
      decision: decision ? "allow" : "deny",
      ...(decision ? {} : { reason: "Denied during smoke test" })
    });
    console.log(`Resumed turn: ${resumedTurn.id} | Status: ${resumedTurn.status}`);
    events = await runtime.listSessionEvents(session.id);
  }

  console.log("\nDone. Full event log summary:");
  console.log(JSON.stringify(await runtime.listSessionEvents(session.id), null, 2));
}

function summarize(raw: unknown): string {
  const text = JSON.stringify(raw);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim().toLowerCase().startsWith("y"));
    });
  });
}

main().catch((error) => {
  console.error("Smoke test failed with error:", error);
  process.exit(1);
});
