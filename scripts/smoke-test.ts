// Real end-to-end smoke test for PatchPilotHarnessRuntime, bypassing the
// webhook/dashboard pipeline so a single run can be watched from the CLI.
//
// Requires real credentials in the environment (never pass them as CLI args
// or paste them into chat):
//   AI_API_KEY       - required
//   GITHUB_TOKEN      - required, needs repo scope on the target repository
//   SMOKE_OWNER       - GitHub owner, e.g. "omkar-hadole"
//   SMOKE_REPO        - GitHub repo, e.g. "PatchPilot"
//   SMOKE_ISSUE       - issue number to reproduce/fix
//   SMOKE_BASE_BRANCH - defaults to "main"
//
// Run with: node --experimental-strip-types scripts/smoke-test.ts

import { GitHubRestClient } from "@byter/github";
import { PatchPilotHarnessRuntime, modelClientFromEnv } from "@byter/agent";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("SMOKE_OWNER");
  const repo = requireEnv("SMOKE_REPO");
  const issueNumber = Number(requireEnv("SMOKE_ISSUE"));
  const baseBranch = process.env.SMOKE_BASE_BRANCH ?? "main";

  const model = modelClientFromEnv();
  if (!model) {
    console.error("AI_API_KEY is not set.");
    process.exit(1);
  }

  const githubClient = new GitHubRestClient({ token: githubToken });
  const issue = await githubClient.getIssue(owner, repo, issueNumber);

  const runtime = new PatchPilotHarnessRuntime({ githubClient, model });

  console.log(`Starting session for ${owner}/${repo}#${issueNumber}: ${issue.title}`);
  const { session, turn } = await runtime.startSession({
    repository: `${owner}/${repo}`,
    issueUrl: issue.html_url,
    issueTitle: issue.title,
    issueBody: issue.body ?? "",
    baseBranch,
    branchName: `patchpilot/smoke-test-${issueNumber}-${Date.now()}`
  });

  console.log(`Session: ${session.id}  Turn: ${turn.id}  Status: ${turn.status}`);

  let events = await runtime.subscribeToTurn(session.id, turn.id, (event) => {
    console.log(`[event] ${event.type}`, summarize(event.raw));
  });

  const pendingApproval = () => events.find((event) => event.type === "tool.approval_required");

  while (pendingApproval() && !events.some((event) => event.type === "turn.done")) {
    const approvalEvent = pendingApproval()!;
    const raw = approvalEvent.raw as { toolCalls: Array<{ id: string; toolCallId: string }> };
    const toolCallId = raw.toolCalls[0]?.toolCallId ?? raw.toolCalls[0]?.id;
    console.log(`\nApproval required for tool call ${toolCallId}.`);
    const decision = await promptYesNo("Approve this write? [y/N] ");
    const resumedTurn = await runtime.resolveToolApproval({
      sessionId: session.id,
      previousTurnId: turn.id,
      threadId: "main",
      toolCallId,
      decision: decision ? "allow" : "deny",
      ...(decision ? {} : { reason: "Denied during smoke test" })
    });
    events = await runtime.subscribeToTurn(session.id, resumedTurn.id, (event) => {
      console.log(`[event] ${event.type}`, summarize(event.raw));
    });
  }

  console.log("\nDone. Full event log:");
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
  console.error(error);
  process.exit(1);
});
