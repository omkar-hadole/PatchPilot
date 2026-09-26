import pg from "pg";
const { Pool } = pg;
import { randomUUID } from "node:crypto";

export interface PersistedApprovalReceipt {
  id?: string;
  resolvedAt?: string;
  savedAt?: string;
  runId: string;
  actionId: string;
  patchHash: string;
  resultStatus?: string;
  message?: string;
  pullRequest?: { number: number; url: string };
  reason?: string;
  decision?: "allow" | "deny";
  turn?: { id: string; status: string };
}

export class PostgresStore {
  private pool: pg.Pool;

  constructor(connectionStringOrPool: string | pg.Pool) {
    if (typeof connectionStringOrPool === "string") {
      this.pool = new Pool({
        connectionString: connectionStringOrPool,
        ssl: connectionStringOrPool.includes("localhost") || connectionStringOrPool.includes("127.0.0.1")
          ? false
          : { rejectUnauthorized: false }
      });
    } else {
      this.pool = connectionStringOrPool;
    }
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS webhook_runs (
          id TEXT PRIMARY KEY,
          received_at TIMESTAMPTZ NOT NULL,
          delivery_id TEXT,
          repository TEXT NOT NULL,
          issue_number INT NOT NULL,
          issue_title TEXT,
          record JSONB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_runs_received_at ON webhook_runs(received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_webhook_runs_delivery_id ON webhook_runs(delivery_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_runs_repo_issue ON webhook_runs(repository, issue_number);

        CREATE TABLE IF NOT EXISTS approval_receipts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          receipt JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS trigger_claims (
          key TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);
    } finally {
      client.release();
    }
  }

  async deliveryWasProcessed(deliveryId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM webhook_runs WHERE delivery_id = $1 LIMIT 1`,
      [deliveryId]
    );
    return res.rowCount !== null && res.rowCount > 0;
  }

  async saveWebhookRun(record: any): Promise<void> {
    const id = record.run?.id ?? randomUUID();
    const receivedAt = record.receivedAt ? new Date(record.receivedAt) : new Date();
    const deliveryId = record.deliveryId ?? null;
    const repository = record.repository ?? "";
    const issueNumber = record.run?.issue?.issueNumber ?? 0;
    const issueTitle = record.issueTitle ?? "";

    await this.pool.query(
      `INSERT INTO webhook_runs (id, received_at, delivery_id, repository, issue_number, issue_title, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         received_at = EXCLUDED.received_at,
         delivery_id = EXCLUDED.delivery_id,
         repository = EXCLUDED.repository,
         issue_number = EXCLUDED.issue_number,
         issue_title = EXCLUDED.issue_title,
         record = EXCLUDED.record`,
      [id, receivedAt, deliveryId, repository, issueNumber, issueTitle, JSON.stringify(record)]
    );
  }

  async readLatestRun(): Promise<any | undefined> {
    const res = await this.pool.query(
      `SELECT record FROM webhook_runs ORDER BY received_at DESC LIMIT 1`
    );
    if (res.rows.length === 0) return undefined;
    return res.rows[0].record;
  }

  async findRunById(id: string): Promise<any | undefined> {
    const res = await this.pool.query(
      `SELECT record FROM webhook_runs WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (res.rows.length === 0) return undefined;
    return res.rows[0].record;
  }

  async findLatestAwaitingRunByIssue(repository: string, issueNumber: number): Promise<any | undefined> {
    const res = await this.pool.query(
      `SELECT record FROM webhook_runs
       WHERE repository = $1 AND issue_number = $2
       ORDER BY received_at DESC
       LIMIT 10`,
      [repository, issueNumber]
    );

    for (const row of res.rows) {
      const record = row.record;
      if (
        record.run?.status === "awaiting-approval" ||
        record.trueForge?.pendingApproval
      ) {
        return record;
      }
    }

    return res.rows[0]?.record;
  }

  async issueTriggerWasRecentlyProcessed(
    repository: string,
    issueNumber: number,
    title: string,
    body: string,
    cutoffTimestamp: number
  ): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM webhook_runs
       WHERE repository = $1
         AND issue_number = $2
         AND record->>'issueTitle' = $3
         AND COALESCE(record->>'issueBody', '') = $4
         AND received_at >= $5
       LIMIT 1`,
      [repository, issueNumber, title, body ?? "", new Date(cutoffTimestamp)]
    );
    return res.rowCount !== null && res.rowCount > 0;
  }

  async acquireTriggerClaim(
    key: string,
    duplicateWindowMs: number
  ): Promise<{ acquired: boolean; release: () => Promise<void> }> {
    const now = Date.now();
    const token = randomUUID();

    const client = await this.pool.connect();
    try {
      await client.query(
        `DELETE FROM trigger_claims WHERE updated_at < $1`,
        [now - duplicateWindowMs]
      );

      const insertRes = await client.query(
        `INSERT INTO trigger_claims (key, token, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING
         RETURNING token`,
        [key, token, now]
      );

      if (insertRes.rowCount && insertRes.rowCount > 0) {
        return {
          acquired: true,
          release: async () => {
            await this.pool.query(
              `DELETE FROM trigger_claims WHERE key = $1 AND token = $2`,
              [key, token]
            ).catch(() => {});
          }
        };
      }

      return { acquired: false, release: async () => {} };
    } finally {
      client.release();
    }
  }

  async saveApprovalReceipt(receipt: PersistedApprovalReceipt): Promise<void> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO approval_receipts (id, run_id, receipt)
       VALUES ($1, $2, $3)`,
      [id, receipt.runId, JSON.stringify(receipt)]
    );
  }

  async findApprovalReceipt(runId: string, actionId: string, patchHash: string): Promise<PersistedApprovalReceipt | undefined> {
    const res = await this.pool.query(
      `SELECT receipt FROM approval_receipts
       WHERE run_id = $1
         AND receipt->>'actionId' = $2
         AND receipt->>'patchHash' = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [runId, actionId, patchHash]
    );
    return res.rows[0]?.receipt;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
