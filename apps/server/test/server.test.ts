import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createByterServer } from "../src/server.js";
import { signWebhookPayload } from "@byter/github";

function executableProofEvents(prefix: string, sequenceNumber: number) {
  return [
    { sequenceNumber, type: "model.message", raw: { event: {
      id: `${prefix}-sandbox-command`,
      type: "model.message",
      toolCalls: [{
        id: `${prefix}-sandbox-call`,
        type: "function",
        function: { name: "exec", arguments: JSON.stringify({ command: "node --experimental-strip-types repro.ts" }) }
      }]
    } } },
    { sequenceNumber: sequenceNumber + 1, type: "tool.response", raw: { event: {
      id: `${prefix}-sandbox-response`,
      type: "tool.response",
      toolCallId: `${prefix}-sandbox-call`,
      content: JSON.stringify({ exitCode: 0, stdout: "The focused reproducer passed 3/3 matching executions." })
    } } }
  ];
}

function submittedResultEvent(prefix: string, sequenceNumber: number, result: string) {
  return { sequenceNumber, type: "model.message", raw: { event: {
    id: `${prefix}-result-event`,
    type: "model.message",
    toolCalls: [{
      id: `${prefix}-result-call`,
      type: "function",
      function: { name: "submit_byter_result", arguments: result }
    }]
  } } };
}

describe("Byter production server", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let dataDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.TRUEFORGE_URL;
    delete process.env.TRUEFORGE_API_KEY;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.BYTER_REQUIRE_TRIGGER_LABEL;
    delete process.env.BYTER_TRIGGER_LABEL;
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    dataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");

    const server = createByterServer({ staticDir, dataDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  afterEach(async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
    delete process.env.TRUEFORGE_URL;
    delete process.env.TRUEFORGE_API_KEY;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.BYTER_REQUIRE_TRIGGER_LABEL;
    delete process.env.BYTER_TRIGGER_LABEL;
    await closeServer();
  });

  it("serves health and the built dashboard shell", async () => {
    await expect(fetch(`${baseUrl}/healthz`).then((response) => response.json())).resolves.toEqual({ ok: true });
    await expect(fetch(baseUrl).then((response) => response.text())).resolves.toContain("Byter");
  });

  it("exposes the approval-gated GitHub write tool in production configuration", async () => {
    process.env.MCP_AUTH_TOKEN = "mcp-secret";
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const server = createByterServer({ staticDir, githubClient: {} as any });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mcp-secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.result.tools).toContainEqual(expect.objectContaining({
        name: "create_fix_pull_request",
        annotations: { readOnlyHint: false, destructiveHint: true }
      }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects approval receipts without maintainer authentication", async () => {
    const response = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "missing-run", actionId: "approve-pr", patchHash: "ea26aee839ac" })
    });

    expect(response.status).toBe(401);
  });

  it("rejects approval receipts for non-current run payloads", async () => {
    const response = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: JSON.stringify({ runId: "wrong-run", actionId: "approve-pr", patchHash: "wrong-hash" })
    });

    expect(response.status).toBe(404);
  });

  it("verifies and records GitHub issue webhooks", async () => {
    const emptyLatest = await fetch(`${baseUrl}/api/runs/latest`);
    expect(emptyLatest.status).toBe(404);

    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 17,
        title: "Parser crash",
        body: `Trailing escape crashes the parser. <!-- ${["repro", "smith"].join("")}-audit -->`,
        html_url: "https://github.test/o/r/issues/17"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    const response = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-17",
        "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
      },
      body: payload
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.run.status).toBe("triaging");
    expect(body.trueForge.status).toBe("not-configured");
    await expect(readFile(join(dataDir, "webhook-runs.jsonl"), "utf8")).resolves.toContain("Parser crash");

    const latest = await fetch(`${baseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
    expect(latest.deliveryId).toBe("delivery-17");
    expect(latest.run.id).toBe(body.run.id);
  });

  it("starts on a deliberate label event but ignores later edits with the standing label", async () => {
    process.env.BYTER_REQUIRE_TRIGGER_LABEL = "true";
    const issue = {
      number: 18,
      title: "Parser crash",
      body: "Trailing escape crashes the parser.",
      html_url: "https://github.test/o/r/issues/18",
      labels: [{ name: "byter:run" }]
    };
    const repository = { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } };
    const sendWebhook = async (action: string, deliveryId: string, labelName?: string) => {
      const payload = JSON.stringify({
        action,
        ...(labelName ? { label: { name: labelName } } : {}),
        issue,
        repository
      });
      return fetch(`${baseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": deliveryId,
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
    };

    const labeledResponse = await sendWebhook("labeled", "delivery-label-18", "byter:run");
    expect(labeledResponse.status).toBe(202);
    expect((await labeledResponse.json()).ignored).not.toBe(true);

    const editedResponse = await sendWebhook("edited", "delivery-edit-18");
    expect(editedResponse.status).toBe(202);
    expect(await editedResponse.json()).toMatchObject({ ignored: true });

    const lifecycleLabelResponse = await sendWebhook("labeled", "delivery-lifecycle-label-18", "byter:triaging");
    expect(lifecycleLabelResponse.status).toBe(202);
    expect(await lifecycleLabelResponse.json()).toMatchObject({ ignored: true });
  });

  it("deduplicates opened and labeled deliveries for the same issue trigger", async () => {
    process.env.BYTER_REQUIRE_TRIGGER_LABEL = "true";
    const issue = {
      number: 19,
      title: "Parser loses escaped character case",
      body: "An escaped uppercase character is lowercased.",
      html_url: "https://github.test/o/r/issues/19",
      labels: [{ name: "byter:run" }]
    };
    const repository = { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } };
    const sendWebhook = async (action: "opened" | "labeled", deliveryId: string) => {
      const payload = JSON.stringify({
        action,
        ...(action === "labeled" ? { label: { name: "byter:run" } } : {}),
        issue,
        repository
      });
      return fetch(`${baseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": deliveryId,
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
    };

    const openedResponse = await sendWebhook("opened", "delivery-opened-19");
    expect(openedResponse.status).toBe(202);
    expect((await openedResponse.json()).ignored).not.toBe(true);

    const labeledResponse = await sendWebhook("labeled", "delivery-labeled-19");
    expect(labeledResponse.status).toBe(202);
    await expect(labeledResponse.json()).resolves.toEqual({
      ignored: true,
      reason: "Duplicate issue trigger"
    });

    const reopenedResponse = await sendWebhook("reopened", "delivery-reopened-19");
    expect(reopenedResponse.status).toBe(202);
    expect((await reopenedResponse.json()).ignored).not.toBe(true);

    const persisted = (await readFile(join(dataDir, "webhook-runs.jsonl"), "utf8")).trim().split("\n");
    expect(persisted).toHaveLength(2);
  });

  it("protects renewed atomic claims from stale owner releases", async () => {
    const claimsDir = join(dataDir, ".claims");
    await mkdir(claimsDir, { recursive: true });
    const key = "owner/repo#99:testhash";
    const safeName = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const lockFile = join(claimsDir, `claim-${safeName}.lock`);

    // Simulate Process A writing an old lock that expired 2 minutes ago
    const oldTime = Date.now() - 120_000;
    const oldToken = "token-process-a";
    await writeFile(lockFile, JSON.stringify({ key, time: oldTime, token: oldToken }), "utf8");

    // Process B encounters the expired lock, renews it with a new token
    const issue = {
      number: 99,
      title: "Stale claim issue",
      body: "body",
      html_url: "https://github.test/owner/repo/issues/99"
    };
    const repository = { name: "repo", full_name: "owner/repo", default_branch: "main", owner: { login: "owner" } };
    const payload = JSON.stringify({
      action: "opened",
      issue,
      repository
    });
    const response = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-stale-takeover-99",
        "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
      },
      body: payload
    });
    expect(response.status).toBe(202);
    expect((await response.json()).ignored).not.toBe(true);
  });

  it("surfaces a non-recoverable TrueForge provider error without retrying", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-live-1", title: null },
        turn: { id: "turn-live-1", sessionId: "session-live-1", status: "running" }
      }),
      subscribeToTurn: vi.fn().mockResolvedValue([
        { sequenceNumber: 1, type: "turn.started", raw: { secret: "do-not-persist" } },
        { sequenceNumber: 2, type: "turn.done", raw: {
          output: "proof ready",
          state: { status: "error", message: "Request failed (400): response_format unavailable" }
        } }
      ]),
      requestProofContract: vi.fn()
    };
    const githubClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: 701, html_url: "https://github.test/issues/20#issuecomment-701" }),
      addLabels: vi.fn().mockResolvedValue(undefined)
    } as any;
    const server = createByterServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime, githubClient });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 20,
        title: "Parser crash in production",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/20"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-live-20",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(trueForgeRuntime.startSession).toHaveBeenCalledWith({
        repository: "o/r",
        issueUrl: "https://github.test/o/r/issues/20",
        issueTitle: "Parser crash in production",
        issueBody: "Trailing escape crashes the parser.",
        baseBranch: "main",
        branchName: "byter/fix-20-866c2789a3"
      });
      expect(body.run.status).toBe("environment-building");
      expect(body.trueForge.status).toBe("started");
      expect(body.trueForge.session.id).toBe("session-live-1");
      expect(trueForgeRuntime.subscribeToTurn).toHaveBeenCalledWith("session-live-1", "turn-live-1", expect.any(Function));

      let latest: any;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        latest = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
        if (latest.trueForge.status === "completed") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(latest.trueForge.status).toBe("completed");
      expect(latest.run.status).toBe("failed");
      expect(latest.trueForge.error).toContain("response_format unavailable");
      expect(trueForgeRuntime.requestProofContract).not.toHaveBeenCalled();
      expect(latest.trueForge.events).toHaveLength(2);
      expect(latest.trueForge.events.map((event: { type: string }) => event.type)).toEqual(["step.started", "step.done"]);
      expect(latest.trueForge.events[0]).toMatchObject({
        type: "step.started",
        category: "agent",
        source: "trueforge"
      });
      expect(latest.trueForge.events[0].sequenceNumber).toBeUndefined();
      expect(latest.trueForge.session).toBeUndefined();
      expect(latest.trueForge.turn).toBeUndefined();
      expect(JSON.stringify(latest)).not.toContain("do-not-persist");
      expect(githubClient.createIssueComment).toHaveBeenCalledTimes(2);
      expect(githubClient.createIssueComment.mock.calls[1]?.[3]).toContain("response_format unavailable");
      expect(githubClient.addLabels).toHaveBeenCalledWith("o", "r", 20, ["byter:triaging"]);
      await expect(readFile(join(liveDataDir, "webhook-runs.jsonl"), "utf8")).resolves.toContain("session-live-1");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("continues across repeated token cutoffs and binds approval to the final turn", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const recoveryResult = JSON.stringify({
      kind: "byter.result",
      status: "patch-ready",
      summary: "The reported tokenizer failure was reproduced three times.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "Focused regression passed", attempts: "3/3" },
      candidatePatch: {
        title: "Fix parser crash",
        body: "Verified by recovery.",
        baseBranch: "main",
        files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
      }
    });
    const writeArguments = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: `byter/fix-22-${createHash("sha256").update("delivery-recovery-22").digest("hex").slice(0, 10)}`,
      title: "Fix parser crash",
      body: "Verified by recovery.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };
    const initialDoneEvent = { sequenceNumber: 1, type: "turn.done", raw: { state: { status: "done" } } };
    const firstContinuationDoneEvent = {
      sequenceNumber: 2,
      type: "turn.done",
      raw: { event: { id: "continuation-one-done", type: "turn.done", state: { status: "done" } } }
    };
    const recoveryEvents = [
      ...executableProofEvents("recovery", 2),
      submittedResultEvent("recovery", 4, recoveryResult),
      { sequenceNumber: 5, type: "model.message", raw: { event: {
        id: "recovery-write-event",
        type: "model.message",
        toolCalls: [{
          id: "recovery-write-call",
          type: "function",
          function: { name: "create_fix_pull_request", arguments: JSON.stringify(writeArguments) }
        }]
      } } },
      { sequenceNumber: 6, type: "tool.approval_required", raw: { event: {
        id: "recovery-approval-event",
        type: "tool.approval_required",
        threadId: "recovery-thread",
        toolCalls: [{ id: "recovery-write-call", sourceEventId: "recovery-write-event" }]
      } } }
    ];
    let sessionListCount = 0;
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-recovery-1", title: null },
        turn: { id: "turn-recovery-1", sessionId: "session-recovery-1", status: "running" }
      }),
      requestProofContract: vi.fn()
        .mockResolvedValueOnce({
          id: "turn-recovery-2",
          sessionId: "session-recovery-1",
          status: "running"
        })
        .mockResolvedValueOnce({
          id: "turn-recovery-3",
          sessionId: "session-recovery-1",
          status: "running"
        }),
      subscribeToTurn: vi.fn().mockImplementation(async (_sessionId: string, turnId: string) => {
        if (turnId === "turn-recovery-1") {
          return [initialDoneEvent];
        }
        throw new Error("Recovery stream disconnected");
      }),
      listSessionEvents: vi.fn().mockImplementation(async () => {
        sessionListCount += 1;
        if (sessionListCount === 1) return [initialDoneEvent];
        if (sessionListCount === 2) return [initialDoneEvent, firstContinuationDoneEvent];
        return [initialDoneEvent, firstContinuationDoneEvent, ...recoveryEvents];
      })
    };
    const githubClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: 702, html_url: "https://github.test/issues/22#issuecomment-702" }),
      addLabels: vi.fn().mockResolvedValue(undefined)
    } as any;
    const server = createByterServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime, githubClient });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 22,
        title: "Parser crash with trailing escape",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/22"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-recovery-22",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      expect(response.status).toBe(202);

      let latest: any;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        latest = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
        if (latest.run.status === "awaiting-approval") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(trueForgeRuntime.requestProofContract).toHaveBeenCalledTimes(2);
      expect(trueForgeRuntime.requestProofContract).toHaveBeenCalledWith("session-recovery-1");
      expect(trueForgeRuntime.subscribeToTurn).toHaveBeenCalledTimes(3);
      expect(trueForgeRuntime.listSessionEvents).toHaveBeenCalledTimes(3);
      expect(latest.run.status).toBe("awaiting-approval");
      expect(latest.trueForge.status).toBe("paused");
      expect(latest.trueForge.error).toBeUndefined();
      expect(latest.trueForge.result.status).toBe("patch-ready");
      const persistedLines = (await readFile(join(liveDataDir, "webhook-runs.jsonl"), "utf8")).trim().split("\n");
      const persisted = JSON.parse(persistedLines.at(-1)!);
      expect(persisted.trueForge.pendingApproval.turnId).toBe("turn-recovery-3");
      expect(githubClient.addLabels).toHaveBeenCalledWith("o", "r", 22, ["byter:verified"]);
      expect(githubClient.addLabels).toHaveBeenCalledWith("o", "r", 22, ["byter:awaiting-approval"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("refreshes persisted TrueForge events when the stream omits the final output", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const recoveryResult = JSON.stringify({
      kind: "byter.result",
      status: "verified",
      summary: "The persisted terminal output contains the verified proof.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "Focused regression passed", attempts: "3/3" },
      candidatePatch: null
    });
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-refresh-1", title: null },
        turn: { id: "turn-refresh-1", sessionId: "session-refresh-1", status: "running" }
      }),
      subscribeToTurn: vi.fn().mockResolvedValue([
        { sequenceNumber: 1, type: "turn.done", raw: { state: { status: "done", output: null } } }
      ]),
      listSessionEvents: vi.fn().mockResolvedValue([
        ...executableProofEvents("refresh", 2),
        submittedResultEvent("refresh", 4, recoveryResult),
        { sequenceNumber: 5, type: "turn.done", raw: { state: { status: "done", output: { content: recoveryResult } } } }
      ])
    };
    const githubClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: 703, html_url: "https://github.test/issues/23#issuecomment-703" }),
      addLabels: vi.fn().mockResolvedValue(undefined)
    } as any;
    const server = createByterServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime, githubClient });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 23,
        title: "Persisted proof output",
        body: "The terminal output is only available through the session event list.",
        html_url: "https://github.test/o/r/issues/23"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-refresh-23",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      expect(response.status).toBe(202);

      let latest: any;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        latest = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
        if (latest.trueForge.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(trueForgeRuntime.listSessionEvents).toHaveBeenCalledWith("session-refresh-1");
      expect(latest.run.status).toBe("verified");
      expect(latest.trueForge.result.status).toBe("verified");
      expect(githubClient.addLabels).toHaveBeenCalledWith("o", "r", 23, ["byter:verified"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects a positive patch result without the mandatory TrueForge approval checkpoint", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const proofText = JSON.stringify({
      kind: "byter.result",
      status: "patch-ready",
      summary: "The focused reproducer failed before the verified tokenizer fix.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "2/2 passed", attempts: "3/3" },
      candidatePatch: {
        title: "Preserve escaped literal case",
        body: "Keep escaped uppercase literals unchanged.",
        files: [{ path: "demo/buggy-parser/src/tokenizer.ts", content: "export const fixed = true;\n" }]
      }
    });
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-no-checkpoint", title: null },
        turn: { id: "turn-no-checkpoint", sessionId: "session-no-checkpoint", status: "running" }
      }),
      subscribeToTurn: vi.fn().mockResolvedValue([
        ...executableProofEvents("no-checkpoint", 1),
        submittedResultEvent("no-checkpoint", 3, proofText),
        { sequenceNumber: 4, type: "turn.done", raw: { event: { id: "no-checkpoint-done", type: "turn.done" } } }
      ])
    };
    const githubClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: 704, html_url: "https://github.test/issues/24#issuecomment-704" }),
      updateIssueComment: vi.fn().mockImplementation(async (_owner: string, _repo: string, id: number) => ({ id, html_url: "https://github.test/issues/24#issuecomment-704" })),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined)
    } as any;
    const server = createByterServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime, githubClient });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 24, title: "Escaped literal case", body: "Uppercase escapes are lowercased.", html_url: "https://github.test/o/r/issues/24" },
      repository: { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-no-checkpoint-24",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      expect(response.status).toBe(202);

      let latest: any;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        latest = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
        if (latest.run.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(latest.run.status).toBe("failed");
      expect(latest.trueForge.error).toContain("native approval checkpoint");
      expect(githubClient.addLabels).not.toHaveBeenCalledWith("o", "r", 24, ["byter:verified"]);
      expect(githubClient.updateIssueComment.mock.calls.at(-1)?.[3]).toContain("complete proof-and-approval contract");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("persists live proof and resumes the exact TrueForge MCP approval", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const proofText = JSON.stringify({
      kind: "byter.result",
      status: "patch-ready",
      summary: "Reproduced 3/3 and passed the regression check.",
      proof: { before: "3/3 failed in /tmp/private/repro.ts with token=fixture-sensitive", after: "3/3 passed", regressions: "passed", attempts: "3/3" },
      candidatePatch: {
        title: "Fix parser crash",
        body: "Verified by Byter.",
        baseBranch: "main",
        files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
      }
    });
    const writeArguments = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: `byter/fix-21-${createHash("sha256").update("delivery-proof-21").digest("hex").slice(0, 10)}`,
      title: "Fix parser crash",
      body: "Verified by Byter.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };
    let approvalSubscriptionAttempts = 0;
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-proof-1", title: null },
        turn: { id: "turn-proof-1", sessionId: "session-proof-1", status: "running" }
      }),
      resolveToolApproval: vi.fn().mockResolvedValue({
        id: "turn-approval-1",
        sessionId: "session-proof-1",
        status: "running"
      }),
      subscribeToTurn: vi.fn().mockImplementation(async (_sessionId: string, turnId: string) => {
        if (turnId === "turn-approval-1") {
          approvalSubscriptionAttempts += 1;
          if (approvalSubscriptionAttempts === 1) {
            throw new Error("Approval turn stream disconnected");
          }
          return [
            { sequenceNumber: 6, type: "tool.response", raw: { event: {
              id: "event-response-1",
              type: "tool.response",
              threadId: "thread-write-1",
              toolCallId: "call-write-1",
              content: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ number: 42, url: "https://github.test/pull/42" }) }] })
            } } },
            { sequenceNumber: 7, type: "turn.done", raw: { event: { type: "turn.done", state: { status: "done" } } } }
          ];
        }
        return [
            { sequenceNumber: 1, type: "model.message.delta", raw: { event: {
              type: "model.message.delta",
              content: `Proof complete. Candidate patch follows:\n\`\`\`json\n${proofText.slice(0, Math.ceil(proofText.length / 2))}`
            } } },
            { sequenceNumber: 2, type: "model.message.delta", raw: { event: {
              type: "model.message.delta",
              content: `${proofText.slice(Math.ceil(proofText.length / 2))}\n\`\`\``
            } } },
            ...executableProofEvents("proof", 3),
            submittedResultEvent("proof", 5, proofText),
            { sequenceNumber: 6, type: "model.message", raw: { event: {
              id: "event-write-1",
              type: "model.message",
              toolCalls: [{
                id: "call-write-1",
                type: "function",
                function: { name: "create_fix_pull_request", arguments: JSON.stringify(writeArguments) }
              }]
            } } },
            { sequenceNumber: 7, type: "tool.approval_required", raw: { event: {
              id: "event-approval-1",
              type: "tool.approval_required",
              threadId: "thread-write-1",
              toolCalls: [{ id: "call-write-1", sourceEventId: "event-write-1" }]
            } } }
          ];
      })
    };
    const githubClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: 700, html_url: "https://github.test/issues/21#issuecomment-700" }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      updateIssueComment: vi.fn().mockImplementation(async (_owner: string, _repo: string, id: number) => ({ id, html_url: "https://github.test/issues/21#issuecomment-700" }))
    } as any;
    const server = createByterServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime, githubClient });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 21,
        title: "Parser crash with trailing escape",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/21"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-proof-21",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      expect(response.status).toBe(202);

      let latest: any;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        latest = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
        if (latest.run.status === "awaiting-approval") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(latest.run.status).toBe("awaiting-approval");
      expect(latest.trueForge.result.candidatePatch.files[0].path).toBe("src/parser.ts");
      expect(latest.trueForge.result.proof.before).toContain("[sandbox path]");
      expect(latest.issueBody).toBe("Trailing escape crashes the parser.");
      expect(JSON.stringify(latest)).not.toContain("/tmp/private/repro.ts");
      expect(JSON.stringify(latest)).not.toContain("fixture-sensitive");
      expect(latest.githubComments).toHaveLength(1);
      expect(latest.verifiedLabel.name).toBe("byter:verified");
      expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
      expect(githubClient.createIssueComment.mock.calls[0]?.[3]).toContain("## Byter · Environment building");
      expect(githubClient.createIssueComment.mock.calls[0]?.[3]).not.toContain("approve");
      expect(githubClient.updateIssueComment).toHaveBeenCalledTimes(1);
      expect(githubClient.updateIssueComment.mock.calls[0]?.[3]).toContain("### Proposed fix");
      expect(githubClient.updateIssueComment.mock.calls[0]?.[3]).toContain("Review evidence & approve patch");
      expect(githubClient.updateIssueComment.mock.calls[0]?.[3]).toContain("src/parser.ts");
      expect(githubClient.updateIssueComment.mock.calls[0]?.[3]).not.toContain("export const fixed = true;");
      expect(githubClient.addLabels).toHaveBeenCalledWith("o", "r", 21, ["byter:verified"]);
      expect(githubClient.addLabels).toHaveBeenCalledWith("o", "r", 21, ["byter:awaiting-approval"]);
      const runRecord = await fetch(`${isolatedBaseUrl}/api/runs/${encodeURIComponent(latest.run.id)}`).then((runResponse) => runResponse.json());
      expect(runRecord.run.id).toBe(latest.run.id);
      expect(runRecord.trueForge.session).toBeUndefined();
      expect(runRecord.trueForge.turn).toBeUndefined();

      const approvalPayload = JSON.stringify({
        action: "created",
        issue: payload ? JSON.parse(payload).issue : undefined,
        comment: {
          body: "approve",
          user: { login: "maintainer" },
          author_association: "OWNER"
        },
        repository: JSON.parse(payload).repository
      });
      const interruptedApproval = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-approval-21",
          "X-Hub-Signature-256": signWebhookPayload(approvalPayload, "webhook-secret")
        },
        body: approvalPayload
      });
      const interruptedBody = await interruptedApproval.json();

      expect(interruptedApproval.status).toBe(502);
      expect(interruptedBody.error).toBe("Approval turn stream disconnected");
      expect(trueForgeRuntime.resolveToolApproval).toHaveBeenCalledTimes(1);
      const interruptedLines = (await readFile(join(liveDataDir, "webhook-runs.jsonl"), "utf8")).trim().split("\n");
      const interruptedRecord = JSON.parse(interruptedLines.at(-1)!);
      expect(interruptedRecord.trueForge.pendingApproval.approvalTurnId).toBe("turn-approval-1");
      const approvalReceiptLines = (await readFile(join(liveDataDir, "approvals.jsonl"), "utf8")).trim().split("\n");
      const writingReceipt = approvalReceiptLines.map((line) => JSON.parse(line)).find((receipt) => receipt.resultStatus === "writing");
      await appendFile(join(liveDataDir, "approvals.jsonl"), `${JSON.stringify(writingReceipt)}\n`, "utf8");

      const approval = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-approval-21-retry",
          "X-Hub-Signature-256": signWebhookPayload(approvalPayload, "webhook-secret")
        },
        body: approvalPayload
      });
      const approvalBody = await approval.json();

      expect(approval.status).toBe(200);
      expect(approvalBody.resultStatus).toBe("pr-created");
      expect(approvalBody.pullRequest.url).toBe("https://github.test/pull/42");
      expect(trueForgeRuntime.resolveToolApproval).toHaveBeenCalledWith({
        sessionId: "session-proof-1",
        previousTurnId: "turn-proof-1",
        threadId: "thread-write-1",
        toolCallId: "call-write-1",
        decision: "allow"
      });
      expect(trueForgeRuntime.resolveToolApproval).toHaveBeenCalledTimes(1);
      const duplicateApproval = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-approval-21-duplicate",
          "X-Hub-Signature-256": signWebhookPayload(approvalPayload, "webhook-secret")
        },
        body: approvalPayload
      });
      expect(duplicateApproval.status).toBe(200);
      expect(trueForgeRuntime.resolveToolApproval).toHaveBeenCalledTimes(1);
      const finalRun = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
      expect(finalRun.run.status).toBe("pr-created");
      expect(finalRun.trueForge.result.pullRequest).toEqual({ number: 42, url: "https://github.test/pull/42" });
      expect(githubClient.createIssueComment).toHaveBeenCalledTimes(1);
      expect(githubClient.updateIssueComment).toHaveBeenCalledTimes(2);
      expect(githubClient.updateIssueComment.mock.calls.at(-1)?.[3]).toContain("Fix proposed");
      expect(githubClient.updateIssueComment.mock.calls.at(-1)?.[3]).not.toContain("awaiting");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("matches a native approval when its source event wrapper differs", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const proofText = JSON.stringify({
      kind: "byter.result",
      status: "patch-ready",
      summary: "Reproduced 3/3 and passed the regression check.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "passed", attempts: "3/3" },
      candidatePatch: {
        title: "Fix parser crash",
        body: "Verified by Byter.",
        files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
      }
    });
    const writeArguments = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: `byter/fix-23-${createHash("sha256").update("delivery-proof-23").digest("hex").slice(0, 10)}`,
      title: "Fix parser crash",
      body: "Verified by Byter.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-proof-2", title: null },
        turn: { id: "turn-proof-2", sessionId: "session-proof-2", status: "running" }
      }),
      subscribeToTurn: vi.fn().mockResolvedValue([
        ...executableProofEvents("proof-23", 1),
        submittedResultEvent("proof-23", 1, proofText),
        {
          sequenceNumber: 3,
          type: "model.message",
          raw: {
            data: {
              id: "stream-wrapper-id",
              type: "model.message",
              tool_calls: [{
                id: "call-write-23",
                type: "function",
                function: { name: "create_fix_pull_request", arguments: JSON.stringify(writeArguments) }
              }]
            }
          }
        },
        {
          sequenceNumber: 4,
          type: "tool.approval_required",
          raw: {
            event: {
              id: "approval-wrapper-id",
              type: "tool.approval_required",
              thread_id: "thread-write-23",
              tool_calls: [{ id: "call-write-23", source_event_id: "different-wrapper-id" }]
            }
          }
        }
      ])
    };
    const githubClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: 723, html_url: "https://github.test/issues/23#issuecomment-723" }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      updateIssueComment: vi.fn().mockResolvedValue({ id: 723, html_url: "https://github.test/issues/23#issuecomment-723" })
    } as any;
    const server = createByterServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime, githubClient });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 23, title: "Parser crash", body: "Parser crashes.", html_url: "https://github.test/o/r/issues/23" },
      repository: { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-proof-23",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      expect(response.status).toBe(202);

      let latest: any;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        latest = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
        if (latest.run.status === "awaiting-approval") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(latest.run.status).toBe("awaiting-approval");
      expect(latest.trueForge.pendingApproval).toBeUndefined();
      expect(latest.trueForge.status).toBe("paused");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("deduplicates repeated GitHub delivery IDs", async () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 18,
        title: "Parser crash again",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/18"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });
    const headers = {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-18",
      "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
    };

    const first = await fetch(`${baseUrl}/api/github/webhook`, { method: "POST", headers, body: payload });
    const second = await fetch(`${baseUrl}/api/github/webhook`, { method: "POST", headers, body: payload });
    const duplicate = await second.json();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(duplicate).toEqual({ ignored: true, reason: "Duplicate GitHub delivery" });
  });

  it("rejects GitHub webhooks with invalid signatures", async () => {
    const response = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-bad",
        "X-Hub-Signature-256": "sha256=bad"
      },
      body: "{}"
    });

    expect(response.status).toBe(403);
  });

  it("returns 400 for malformed signed GitHub issue payloads", async () => {
    const payload = "{}";
    const response = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "delivery-malformed",
        "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
      },
      body: payload
    });

    expect(response.status).toBe(400);
  });

  it("requires DATA_DIR before accepting persistent write endpoints", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const server = createByterServer({ staticDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 19,
        title: "Parser crash",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/19"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const approval = await fetch(`${isolatedBaseUrl}/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
        body: JSON.stringify({ runId: "missing-run", actionId: "approve-pr", patchHash: "ea26aee839ac" })
      });
      const webhook = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-no-data-dir",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });

      expect(approval.status).toBe(503);
      expect(webhook.status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("returns client errors for malformed JSON and oversized bodies", async () => {
    const malformed = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: "{"
    });
    const oversized = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: JSON.stringify({ runId: "missing-run", actionId: "approve-pr", patchHash: "x".repeat(70_000) })
    });

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("reconciles session events across transient listing errors and recovers the approval write", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "byter-static-"));
    const liveDataDir = await mkdtemp(join(tmpdir(), "byter-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
    const proofText = JSON.stringify({
      kind: "byter.result",
      status: "patch-ready",
      summary: "Reproduced 3/3 and passed the regression check.",
      proof: { before: "3/3 failed", after: "3/3 passed", regressions: "passed", attempts: "3/3" },
      candidatePatch: {
        title: "Fix parser crash",
        body: "Verified by Byter.",
        baseBranch: "main",
        files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
      }
    });
    const writeArguments = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: `byter/fix-55-${createHash("sha256").update("delivery-reconcile-55").digest("hex").slice(0, 10)}`,
      title: "Fix parser crash",
      body: "Verified by Byter.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };
    const pauseEvents = [
      { sequenceNumber: 1, type: "model.message.delta", raw: { event: {
        type: "model.message.delta",
        content: `Proof complete:\n\`\`\`json\n${proofText}\n\`\`\``
      } } },
      ...executableProofEvents("reconcile", 2),
      submittedResultEvent("reconcile", 4, proofText),
      { sequenceNumber: 5, type: "model.message", raw: { event: {
        id: "event-write-55",
        type: "model.message",
        toolCalls: [{
          id: "call-write-55",
          type: "function",
          function: { name: "create_fix_pull_request", arguments: JSON.stringify(writeArguments) }
        }]
      } } },
      { sequenceNumber: 6, type: "tool.approval_required", raw: { event: {
        id: "event-approval-55",
        type: "tool.approval_required",
        threadId: "thread-write-55",
        toolCalls: [{ id: "call-write-55", sourceEventId: "event-write-55" }]
      } } }
    ];
    const writeResponseEvent = { sequenceNumber: 4, type: "tool.response", raw: { event: {
      id: "event-response-55",
      type: "tool.response",
      threadId: "thread-write-55",
      toolCallId: "call-write-55",
      content: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ number: 99, url: "https://github.test/pull/99" }) }] })
    } } };

    let listAttempts = 0;
    const trueForgeRuntime = {
      startSession: vi.fn().mockResolvedValue({
        session: { id: "session-rec-1", title: null },
        turn: { id: "turn-rec-1", sessionId: "session-rec-1", status: "running" }
      }),
      resolveToolApproval: vi.fn().mockResolvedValue({
        id: "turn-approval-55",
        sessionId: "session-rec-1",
        status: "running"
      }),
      subscribeToTurn: vi.fn().mockImplementation(async (_sessionId: string, turnId: string) => {
        if (turnId === "turn-rec-1") {
          // Monitor stream drops
          throw new Error("Stream connection dropped");
        }
        // Approval stream drops
        throw new Error("Approval stream connection dropped");
      }),
      listSessionEvents: vi.fn().mockImplementation(async () => {
        listAttempts += 1;
        // First listing attempt fails transiently
        if (listAttempts === 1) {
          throw new Error("Temporary network timeout from TrueForge API");
        }
        if (listAttempts <= 3) {
          return pauseEvents;
        }
        return [...pauseEvents, writeResponseEvent];
      })
    };
    const githubClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: 888, html_url: "https://github.test/issues/55#issuecomment-888" }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      updateIssueComment: vi.fn().mockImplementation(async (_owner: string, _repo: string, id: number) => ({ id, html_url: "https://github.test/issues/55#issuecomment-888" }))
    } as any;
    const server = createByterServer({ staticDir, dataDir: liveDataDir, trueForgeRuntime, githubClient });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 55,
        title: "Parser crash with trailing escape",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/55"
      },
      repository: {
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        owner: { login: "o" }
      }
    });

    try {
      const response = await fetch(`${isolatedBaseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-reconcile-55",
          "X-Hub-Signature-256": signWebhookPayload(payload, "webhook-secret")
        },
        body: payload
      });
      expect(response.status).toBe(202);

      let latest: any;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        latest = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
        if (latest.run.status === "awaiting-approval") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(latest.run.status).toBe("awaiting-approval");
      const patchHash = latest.trueForge.result.candidatePatch.hash;

      const approval = await fetch(`${isolatedBaseUrl}/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
        body: JSON.stringify({ runId: latest.run.id, actionId: "approve-pr", patchHash })
      });
      const approvalBody = await approval.json();
      expect(approval.status).toBe(200);
      expect(approvalBody.resultStatus).toBe("pr-created");
      expect(approvalBody.pullRequest).toEqual({ number: 99, url: "https://github.test/pull/99" });

      const finalRun = await fetch(`${isolatedBaseUrl}/api/runs/latest`).then((latestResponse) => latestResponse.json());
      expect(finalRun.run.status).toBe("pr-created");
      expect(finalRun.trueForge.result.pullRequest).toEqual({ number: 99, url: "https://github.test/pull/99" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("serves the default built web directory from the package working directory", async () => {
    const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const previousCwd = process.cwd();
    process.chdir(packageDir);
    try {
      const server = createByterServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("id=\"root\"");
    } finally {
      process.chdir(previousCwd);
    }
  });
});
