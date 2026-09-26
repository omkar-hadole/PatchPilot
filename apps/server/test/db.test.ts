import { describe, expect, it, vi } from "vitest";
import { PostgresStore } from "../src/db.js";

describe("PostgresStore unit tests", () => {
  it("initializes tables and queries delivery, runs, and trigger claims", async () => {
    const queryMock = vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("CREATE TABLE")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT 1 FROM webhook_runs WHERE delivery_id = $1")) {
        return { rowCount: params?.[0] === "existing-del" ? 1 : 0, rows: [] };
      }
      if (sql.includes("INSERT INTO webhook_runs")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT record FROM webhook_runs ORDER BY received_at DESC LIMIT 1")) {
        return {
          rowCount: 1,
          rows: [{ record: { run: { id: "run-1" }, issueTitle: "Test Issue" } }]
        };
      }
      if (sql.includes("SELECT record FROM webhook_runs WHERE id = $1 LIMIT 1")) {
        return {
          rowCount: params?.[0] === "run-1" ? 1 : 0,
          rows: params?.[0] === "run-1" ? [{ record: { run: { id: "run-1" } } }] : []
        };
      }
      if (sql.includes("SELECT record FROM webhook_runs") && sql.includes("WHERE repository = $1 AND issue_number = $2")) {
        return {
          rowCount: 1,
          rows: [
            {
              record: {
                run: { id: "run-1", status: "awaiting-approval", issue: { issueNumber: 12 } },
                trueForge: { pendingApproval: { toolCallId: "call_1" } }
              }
            }
          ]
        };
      }
      if (sql.includes("SELECT 1 FROM webhook_runs") && sql.includes("record->>'issueTitle' = $3")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO trigger_claims")) {
        return { rowCount: 1, rows: [{ token: "test-token" }] };
      }
      if (sql.includes("INSERT INTO approval_receipts")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT receipt FROM approval_receipts")) {
        return params?.[0] === "run-1"
          ? { rowCount: 1, rows: [{ receipt: { runId: "run-1", actionId: "approve-pr", patchHash: "abc", resultStatus: "pr-created" } }] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const connectMock = vi.fn().mockResolvedValue({
      query: queryMock,
      release: vi.fn()
    });

    const mockPool: any = {
      connect: connectMock,
      query: queryMock,
      end: vi.fn().mockResolvedValue(undefined)
    };

    const store = new PostgresStore(mockPool);
    await store.init();
    expect(connectMock).toHaveBeenCalled();

    const wasProcessed = await store.deliveryWasProcessed("existing-del");
    expect(wasProcessed).toBe(true);

    const notProcessed = await store.deliveryWasProcessed("non-existing-del");
    expect(notProcessed).toBe(false);

    await store.saveWebhookRun({
      run: { id: "run-1", issue: { issueNumber: 1 } },
      deliveryId: "del-1",
      repository: "owner/repo",
      issueTitle: "Test Issue"
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO webhook_runs"), expect.any(Array));

    const latest = await store.readLatestRun();
    expect(latest?.run?.id).toBe("run-1");

    const found = await store.findRunById("run-1");
    expect(found?.run?.id).toBe("run-1");

    const notFound = await store.findRunById("non-existent");
    expect(notFound).toBeUndefined();

    const awaiting = await store.findLatestAwaitingRunByIssue("owner/repo", 12);
    expect(awaiting?.run?.id).toBe("run-1");

    const recent = await store.issueTriggerWasRecentlyProcessed("owner/repo", 12, "Test Issue", "", Date.now() - 10000);
    expect(recent).toBe(true);

    const claim = await store.acquireTriggerClaim("test-key", 60000);
    expect(claim.acquired).toBe(true);
    await claim.release();

    await store.saveApprovalReceipt({
      runId: "run-1",
      actionId: "approve-pr",
      patchHash: "abc",
      resolvedAt: new Date().toISOString()
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO approval_receipts"), expect.any(Array));

    const receipt = await store.findApprovalReceipt("run-1", "approve-pr", "abc");
    expect(receipt?.resultStatus).toBe("pr-created");

    await store.close();
    expect(mockPool.end).toHaveBeenCalled();
  });
});
