import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookVerificationInput {
  payload: string | Buffer;
  signatureHeader: string | null | undefined;
  secret: string;
}

export interface GitHubIssuePayload {
  action: string;
  label?: { name?: string };
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user?: { login: string };
    labels?: Array<string | { name?: string }>;
  };
  repository: {
    name: string;
    full_name: string;
    default_branch: string;
    owner: { login: string };
  };
  installation?: { id: number };
}

export interface GitHubIssueCommentPayload {
  action: string;
  issue: GitHubIssuePayload["issue"];
  repository: GitHubIssuePayload["repository"];
  comment: {
    body: string | null;
    html_url?: string;
    user?: { login: string };
    author_association?: string;
  };
}

export function signWebhookPayload(payload: string | Buffer, secret: string): string {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${digest}`;
}

export function verifyGitHubWebhook({
  payload,
  signatureHeader,
  secret
}: WebhookVerificationInput): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=") || secret.length === 0) {
    return false;
  }

  const expected = Buffer.from(signWebhookPayload(payload, secret), "utf8");
  const actual = Buffer.from(signatureHeader, "utf8");

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseIssueWebhook(payload: string): GitHubIssuePayload {
  const parsed = JSON.parse(payload) as GitHubIssuePayload;

  if (!parsed.issue || !parsed.repository || typeof parsed.action !== "string") {
    throw new Error("Payload is not a GitHub issues webhook");
  }

  return parsed;
}

export function parseIssueCommentWebhook(payload: string): GitHubIssueCommentPayload {
  const parsed = JSON.parse(payload) as GitHubIssueCommentPayload;

  if (!parsed.issue || !parsed.repository || !parsed.comment || typeof parsed.action !== "string") {
    throw new Error("Payload is not a GitHub issue comment webhook");
  }

  return parsed;
}
