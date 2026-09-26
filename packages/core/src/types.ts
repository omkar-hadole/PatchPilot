export type RunStatus =
  | "received"
  | "security-review"
  | "rejected"
  | "triaging"
  | "needs-info"
  | "failed"
  | "environment-building"
  | "environment-failed"
  | "reproducing"
  | "not-reproduced"
  | "flaky"
  | "verified"
  | "minimizing"
  | "fixing"
  | "validating"
  | "fix-failed"
  | "patch-ready"
  | "awaiting-approval"
  | "approved"
  | "pr-created";

export interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
  url: string;
  baseSha?: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  status: RunStatus;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface ReproRun {
  id: string;
  issue: GitHubIssueRef;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: RunEvent[];
}

export interface SecurityFinding {
  ruleId: string;
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  matchedText: string;
}

export interface SecurityScanResult {
  safeToExecute: boolean;
  findings: SecurityFinding[];
}
