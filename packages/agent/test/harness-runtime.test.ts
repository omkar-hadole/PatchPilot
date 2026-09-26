import { describe, expect, it } from "vitest";
import { PatchPilotHarnessRuntime } from "../src/harness-runtime.js";
import type { ModelClientLike, ModelMessage, ModelResponse, ModelToolSchema } from "../src/model-client.js";
import type { SandboxExecutionResult, SandboxProvider, SandboxWorkspace } from "../src/sandbox.js";
import type { GitHubRestClientLike } from "@byter/github-mcp";

const baseInput = {
  issueUrl: "https://github.com/acme/widgets/issues/32",
  issueTitle: "Off-by-one in paginate()",
  issueBody: "paginate() drops the last item on the final page.",
  repository: "acme/widgets",
  baseBranch: "main",
  branchName: "byter/fix-32"
};

function scriptedModel(responses: ModelResponse[]): ModelClientLike {
  let call = 0;
  return {
    async chat(_messages: ModelMessage[], _tools: ModelToolSchema[]): Promise<ModelResponse> {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return response;
    }
  };
}

function fakeSandbox(): SandboxProvider {
  return {
    async createWorkspace(id: string): Promise<SandboxWorkspace> {
      return {
        id,
        dir: "/tmp/fake",
        async exec(command: string): Promise<SandboxExecutionResult> {
          return { command, exitCode: 0, stdout: "3/3 reproduced\n", stderr: "", timedOut: false, durationMs: 5 };
        },
        async cleanup() {}
      };
    }
  };
}

function fakeGitHubClient(overrides: Partial<GitHubRestClientLike> = {}): GitHubRestClientLike {
  return {
    async getIssue() {
      return { number: 32, title: baseInput.issueTitle, body: baseInput.issueBody, html_url: baseInput.issueUrl, state: "open" };
    },
    async getFile() {
      return { path: "src/paginate.ts", sha: "abc", encoding: "utf-8", content: "export function paginate() {}" };
    },
    async addLabels() {},
    async createIssueComment() {
      return { html_url: "https://github.com/acme/widgets/issues/32#comment-1" };
    },
    async getBranch() {
      return { commit: { sha: "base-sha" } };
    },
    async createBranch() {},
    async deleteBranch() {},
    async getCommit() {
      return { tree: { sha: "tree-sha" } };
    },
    async createTree() {
      return { sha: "new-tree-sha" };
    },
    async createCommit() {
      return { sha: "new-commit-sha" };
    },
    async createOrUpdateFile() {},
    async createPullRequest() {
      return { number: 101, html_url: "https://github.com/acme/widgets/pull/101" };
    },
    ...overrides
  };
}

const byterResultArgs = {
  kind: "byter.result",
  status: "patch-ready",
  summary: "Fixed the off-by-one in paginate() and verified with a 3/3 reproduction.",
  proof: {
    before: "repro.ts failed 3/3 before the fix",
    after: "repro.ts passed 3/3 after the fix",
    regressions: "existing suite passed",
    attempts: "3/3"
  },
  candidatePatch: {
    title: "Fix off-by-one in paginate()",
    body: "Corrects the final-page boundary check.",
    files: [{ path: "src/paginate.ts", content: "export function paginate() { /* fixed */ }" }]
  }
};

const createPrArgs = {
  owner: "acme",
  repo: "widgets",
  baseBranch: "main",
  branchName: "byter/fix-32",
  title: "Fix off-by-one in paginate()",
  body: "Corrects the final-page boundary check.",
  files: [{ path: "src/paginate.ts", content: "export function paginate() { /* fixed */ }" }]
};

describe("PatchPilotHarnessRuntime", () => {
  it("runs read -> reproduce -> submit -> pauses for approval on create_fix_pull_request", async () => {
    const model = scriptedModel([
      { content: null, toolCalls: [{ id: "call_1", name: "read_file", arguments: { owner: "acme", repo: "widgets", path: "src/paginate.ts" } }], finishReason: "tool_calls" },
      { content: null, toolCalls: [{ id: "call_2", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }], finishReason: "tool_calls" },
      { content: null, toolCalls: [{ id: "call_3", name: "submit_byter_result", arguments: byterResultArgs }], finishReason: "tool_calls" },
      { content: null, toolCalls: [{ id: "call_4", name: "create_fix_pull_request", arguments: createPrArgs }], finishReason: "tool_calls" }
    ]);

    const runtime = new PatchPilotHarnessRuntime({
      githubClient: fakeGitHubClient(),
      model,
      sandboxProvider: fakeSandbox()
    });

    const { session, turn } = await runtime.startSession(baseInput);
    const events = await runtime.subscribeToTurn(session.id, turn.id);

    expect(events.some((event) => event.type === "tool.approval_required")).toBe(true);
    expect(events.some((event) => event.type === "turn.done")).toBe(false);

    const sandboxEvent = events.find((event) => event.type === "sandbox.created");
    expect(sandboxEvent).toBeDefined();

    const submitEvent = events.find((event) => {
      const raw = event.raw as { tool_calls?: Array<{ function: { name: string } }> };
      return raw.tool_calls?.some((call) => call.function.name === "submit_byter_result");
    });
    expect(submitEvent).toBeDefined();
  });

  it("executes the approved write and reaches turn.done after allow", async () => {
    const model = scriptedModel([
      { content: null, toolCalls: [{ id: "call_3", name: "submit_byter_result", arguments: byterResultArgs }], finishReason: "tool_calls" },
      { content: null, toolCalls: [{ id: "call_4", name: "create_fix_pull_request", arguments: createPrArgs }], finishReason: "tool_calls" },
      { content: JSON.stringify(byterResultArgs), toolCalls: [], finishReason: "stop" }
    ]);

    let pullRequestCreated = false;
    const runtime = new PatchPilotHarnessRuntime({
      githubClient: fakeGitHubClient({
        async createPullRequest() {
          pullRequestCreated = true;
          return { number: 101, html_url: "https://github.com/acme/widgets/pull/101" };
        }
      }),
      model,
      sandboxProvider: fakeSandbox()
    });

    const { session, turn } = await runtime.startSession(baseInput);
    const firstTurnEvents = await runtime.subscribeToTurn(session.id, turn.id);
    const approvalEvent = firstTurnEvents.find((event) => event.type === "tool.approval_required");
    expect(approvalEvent).toBeDefined();
    const raw = approvalEvent!.raw as { toolCalls: Array<{ toolCallId: string }> };
    const toolCallId = raw.toolCalls[0].toolCallId;

    const resumedTurn = await runtime.resolveToolApproval({
      sessionId: session.id,
      previousTurnId: turn.id,
      threadId: "main",
      toolCallId,
      decision: "allow"
    });

    const resumedEvents = await runtime.subscribeToTurn(session.id, resumedTurn.id);
    expect(pullRequestCreated).toBe(true);
    expect(resumedEvents.some((event) => event.type === "turn.done")).toBe(true);

    const allEvents = await runtime.listSessionEvents(session.id);
    expect(allEvents.length).toBeGreaterThan(resumedEvents.length);
  });

  it("does not call the write tool when the maintainer denies", async () => {
    const model = scriptedModel([
      { content: null, toolCalls: [{ id: "call_3", name: "submit_byter_result", arguments: byterResultArgs }], finishReason: "tool_calls" },
      { content: null, toolCalls: [{ id: "call_4", name: "create_fix_pull_request", arguments: createPrArgs }], finishReason: "tool_calls" }
    ]);

    let pullRequestCreated = false;
    const runtime = new PatchPilotHarnessRuntime({
      githubClient: fakeGitHubClient({
        async createPullRequest() {
          pullRequestCreated = true;
          return { number: 101, html_url: "https://github.com/acme/widgets/pull/101" };
        }
      }),
      model,
      sandboxProvider: fakeSandbox()
    });

    const { session, turn } = await runtime.startSession(baseInput);
    const events = await runtime.subscribeToTurn(session.id, turn.id);
    const approvalEvent = events.find((event) => event.type === "tool.approval_required");
    const raw = approvalEvent!.raw as { toolCalls: Array<{ toolCallId: string }> };
    const toolCallId = raw.toolCalls[0].toolCallId;

    const resumedTurn = await runtime.resolveToolApproval({
      sessionId: session.id,
      previousTurnId: turn.id,
      threadId: "main",
      toolCallId,
      decision: "deny",
      reason: "Not confident in this fix"
    });

    const resumedEvents = await runtime.subscribeToTurn(session.id, resumedTurn.id);
    expect(pullRequestCreated).toBe(false);
    expect(resumedEvents.some((event) => event.type === "turn.done")).toBe(true);
  });

  it("marks turn.done with a recoverable error when the iteration budget is exhausted", async () => {
    const alwaysToolCall: ModelResponse = {
      content: null,
      toolCalls: [{ id: "call_x", name: "read_issue", arguments: { owner: "acme", repo: "widgets", issueNumber: 32 } }],
      finishReason: "tool_calls"
    };
    const model = scriptedModel([alwaysToolCall]);

    const runtime = new PatchPilotHarnessRuntime({
      githubClient: fakeGitHubClient(),
      model,
      sandboxProvider: fakeSandbox(),
      maxIterations: 3
    });

    const { session, turn } = await runtime.startSession(baseInput);
    const events = await runtime.subscribeToTurn(session.id, turn.id);
    const doneEvent = events.find((event) => event.type === "turn.done");
    expect(doneEvent).toBeDefined();
    const raw = doneEvent!.raw as { state: { status: string; message: string } };
    expect(raw.state.status).toBe("error");
    expect(raw.state.message).toMatch(/token budget/i);
  });
});
