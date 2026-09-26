import type { ReproRun, RunStatus, SecurityScanResult } from "@byter/core";

export type EvidenceKind = "stdout" | "stack" | "patch" | "policy";
export type ApprovalActionId = "approve-pr" | "request-diff" | "reject-run";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  title: string;
  value: string;
  detail: string;
  status: "verified" | "warning" | "blocked";
}

export interface ApprovalAction {
  id: ApprovalActionId;
  label: string;
  description: string;
  impact: "safe" | "review" | "blocked";
}

export interface QuarantinedReport {
  id: string;
  issueNumber: number;
  title: string;
  security: SecurityScanResult;
}

export type HarnessEventCategory = "session" | "agent" | "mcp" | "sandbox" | "subagent" | "github" | "approval";

export interface HarnessTraceEvent {
  id: string;
  sequenceNumber?: number;
  at: string;
  type: string;
  category: HarnessEventCategory;
  source: "trueforge" | "byter";
  status: "info" | "running" | "passed" | "failed";
  summary: string;
  toolName?: string;
  mcpServer?: string;
  target?: string;
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  sandboxId?: string;
  subagent?: string;
  artifact?: string;
}

export interface HarnessState {
  model: string;
  provider: string;
  sessionId?: string;
  turnId?: string;
  status: "running" | "completed" | "paused" | "failed" | "not-configured";
  currentTask: string;
  trace: HarnessTraceEvent[];
  mcpCalls: number;
  sandboxExecutions: number;
  subagents: number;
  dashboardUrl?: string;
  statusCommentUrl?: string;
  commentHistory: Array<{ id?: number; url: string; kind: "started" | "completed" | "failed" | "approval" | "legacy"; createdAt: string }>;
  verifiedLabel?: { name: string; appliedAt?: string; error?: string };
  approvalLabel?: { name: string; appliedAt?: string; error?: string };
}

export interface DashboardRun extends ReproRun {
  generatedAt: string;
  source: "webhook";
  sourceLabel: string;
  repoLabel: string;
  issueTitle: string;
  assignee: string;
  runtime: string;
  model: string;
  currentBranch: string;
  summary?: string;
  rootCauseSummary?: string;
  proposedFixSummary?: string;
  baseSha?: string;
  candidatePatch?: {
    title: string;
    files: string[];
    fileContents?: Array<{ path: string; content: string }>;
    hash: string;
    verifiedAt: string;
    body?: string;
  };
  patchDiff?: Array<{ path: string; before: string; after: string }>;
  pullRequest?: { number: number; url: string };
  proof?: { before?: string; after?: string; regressions?: string; attempts?: string };
  tests: Array<{ id: string; label: string; status: "passed" | "failed" | "pending"; detail: string; log?: string }>;
  harness: HarnessState;
  evidence: EvidenceItem[];
  approvals: ApprovalAction[];
  security: SecurityScanResult;
  quarantinedReports: QuarantinedReport[];
}

interface WebhookRunRecord {
  receivedAt: string;
  deliveryId: string;
  repository: string;
  issueTitle: string;
  issueBody: string;
  dashboardUrl?: string;
  githubStatusComment?: { id?: number; url: string };
  githubComments?: Array<{ id?: number; url: string; kind: "started" | "completed" | "failed" | "approval"; createdAt: string }>;
  verifiedLabel?: { name: "byter:verified"; appliedAt?: string; error?: string };
  approvalLabel?: { name: "byter:awaiting-approval"; appliedAt?: string; error?: string };
  run: ReproRun;
  scan: SecurityScanResult;
  trueForge?: {
    status?: string;
    reason?: string;
    error?: string;
    session?: { id?: string; title?: string | null };
    turn?: { id?: string; status?: string };
    model?: string;
    provider?: string;
    events?: HarnessTraceEvent[];
    result?: {
      status?: string;
      summary?: string;
      rootCauseSummary?: string;
      proposedFixSummary?: string;
      baseSha?: string;
      patchDiff?: Array<{ path: string; before: string; after: string }>;
      proof?: { before?: string; after?: string; regressions?: string; attempts?: string };
      candidatePatch?: {
        title: string;
        body: string;
        baseBranch: string;
        branchName: string;
        files: Array<{ path: string; content: string }>;
        hash: string;
        verifiedAt: string;
      };
      pullRequest?: { number: number; url: string };
    };
  };
}

export function apiUrl(path: string): string {
  const baseUrl = (import.meta.env.VITE_BYTER_API_URL ?? "").trim().replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

export async function fetchDashboardRun(fetchImpl: typeof fetch = fetch): Promise<DashboardRun> {
  const runId = typeof window !== "undefined" && window.location.pathname.startsWith("/runs/")
    ? window.location.pathname.slice("/runs/".length).replace(/\/review\/?$/, "")
    : undefined;
  const endpoint = runId ? `/api/runs/${encodeURIComponent(decodeURIComponent(runId))}` : "/api/runs/latest";
  const liveResponse = await fetchImpl(apiUrl(endpoint), { cache: "no-store" });
  if (!liveResponse.ok) {
    if (liveResponse.status === 404) {
      throw new Error("No persisted GitHub webhook run is available yet");
    }

    throw new Error(`Live run API returned ${liveResponse.status}`);
  }

  return toDashboardRunFromWebhook((await liveResponse.json()) as WebhookRunRecord);
}

export function toDashboardRunFromWebhook(record: WebhookRunRecord): DashboardRun {
  const trueForgeStatus = record.trueForge?.status ?? "unknown";
  const liveResult = record.trueForge?.result;
  const livePatch = liveResult?.candidatePatch;
  const pullRequest = liveResult?.pullRequest;
  const trueForgeDetail =
    (liveResult?.summary ? publicSafeMarkdown(liveResult.summary) : undefined) ??
    record.trueForge?.reason ??
    record.trueForge?.error ??
    "No TrueForge metadata returned";
  const trueForgeBlocked = trueForgeStatus === "failed" || trueForgeStatus === "not-configured" || liveResult?.status === "failed";
  const issueBodySize = new Blob([record.issueBody]).size;
  const trace = (record.trueForge?.events ?? []).map(sanitizeTraceEvent);
  const commentHistory = record.githubComments ?? (record.githubStatusComment ? [{ ...record.githubStatusComment, kind: "legacy" as const, createdAt: record.receivedAt }] : []);
  const latestComment = commentHistory.at(-1);

  return {
    ...record.run,
    events: record.run.events.map((event) => ({
      ...event,
      message: publicSafeMarkdown(event.message)
        .replace(/TrueForge session started/gi, "TrueForge investigation started")
        .replace(/\bsession\b/gi, "investigation")
        .replace(/\bturn\b/gi, "step")
    })),
    generatedAt: record.receivedAt,
    source: "webhook",
    sourceLabel: "latest GitHub webhook",
    repoLabel: record.repository.replace("/", " / "),
    issueTitle: record.issueTitle,
    assignee: trueForgeStatus === "started" || liveResult ? "TrueForge agent" : "Server intake",
    runtime: trueForgeStatus === "started" || liveResult ? "TrueForge Agent Harness" : "Webhook intake",
    model: record.trueForge?.model ?? (trueForgeStatus === "started" || liveResult ? "Configured by TrueForge" : "Not started"),
    currentBranch: livePatch?.branchName ?? `delivery ${record.deliveryId}`,
    ...(liveResult?.summary ? { summary: publicSafeMarkdown(liveResult.summary) } : {}),
    ...(liveResult?.rootCauseSummary ? { rootCauseSummary: publicSafeMarkdown(liveResult.rootCauseSummary) } : {}),
    ...(liveResult?.proposedFixSummary ? { proposedFixSummary: publicSafeMarkdown(liveResult.proposedFixSummary) } : {}),
    ...(liveResult?.baseSha ? { baseSha: liveResult.baseSha } : {}),
    ...(livePatch
      ? {
          candidatePatch: {
            title: livePatch.title,
            files: livePatch.files.map((file) => file.path),
            fileContents: livePatch.files,
            hash: livePatch.hash,
            verifiedAt: livePatch.verifiedAt,
            body: publicSafeMarkdown(livePatch.body)
          }
      }
      : {}),
    ...(liveResult?.patchDiff ? { patchDiff: liveResult.patchDiff } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(liveResult?.proof ? { proof: compactProof(liveResult.proof) } : {}),
    tests: buildLiveTests(liveResult?.proof, trace),
    harness: {
      model: record.trueForge?.model ?? (trueForgeStatus === "started" || liveResult ? "Configured model" : "Not started"),
      provider: record.trueForge?.provider ?? (trueForgeStatus === "started" || liveResult ? "Configured provider" : "Not started"),
      sessionId: record.trueForge?.session?.id,
      turnId: record.trueForge?.turn?.id,
      status: harnessStatusFor(record.run.status, trueForgeStatus, liveResult?.status),
      currentTask: currentTaskFor(record.run.status, liveResult?.summary ? publicSafeMarkdown(liveResult.summary) : undefined),
      trace,
      mcpCalls: trace.filter((event) => event.category === "mcp" && event.type !== "mcp.initialize").length,
      sandboxExecutions: trace.filter((event) => event.category === "sandbox" && (event.command || event.sandboxId || event.stdout || event.stderr)).length,
      subagents: trace.filter((event) => event.category === "subagent").length,
      dashboardUrl: record.dashboardUrl,
      statusCommentUrl: latestComment?.url,
      commentHistory,
      verifiedLabel: record.verifiedLabel,
      approvalLabel: record.approvalLabel
    },
    evidence: [
      {
        id: "security-scan",
        kind: "policy",
        title: "Security scan",
        value: pluralize(record.scan.findings.length, "finding"),
        detail: record.scan.safeToExecute ? "Issue cleared for live orchestration" : "Issue blocked before execution",
        status: record.scan.safeToExecute ? "verified" : "blocked"
      },
      {
        id: "trueforge-session",
        kind: "stdout",
        title: "TrueForge handoff",
        value: trueForgeStatus,
        detail: trueForgeDetail,
        status: trueForgeBlocked ? "blocked" : liveResult ? "verified" : trueForgeStatus === "started" ? "verified" : "warning"
      },
      ...(liveResult?.proof
        ? [
            {
              id: "proof-result",
              kind: "stdout" as const,
              title: "Live proof result",
              value: liveResult.status ?? "unknown",
              detail: [liveResult.proof.attempts, liveResult.proof.before, liveResult.proof.after, liveResult.proof.regressions]
                .filter(Boolean)
                .join(" | "),
              status: liveResult.status === "patch-ready" || liveResult.status === "verified" ? ("verified" as const) : ("warning" as const)
            }
          ]
        : []),
      {
        id: "issue-payload",
        kind: "stack",
        title: "Issue payload",
        value: `${issueBodySize} bytes`,
        detail: `received ${formatWebhookTime(record.receivedAt)}`,
        status: "verified"
      }
    ],
    approvals: record.run.status === "awaiting-approval" && livePatch ? approvalActions : [],
    security: record.scan,
    quarantinedReports: record.scan.findings.length
      ? [
          {
            id: `webhook-${record.deliveryId}`,
            issueNumber: record.run.issue.issueNumber,
            title: record.issueTitle,
            security: record.scan
          }
        ]
      : []
  };
}

export const approvalActions: ApprovalAction[] = [
  {
    id: "approve-pr",
    label: "Approve & Resume",
    description: "Resume TrueForge, commit the verified patch, and open a draft PR.",
    impact: "safe"
  },
  {
    id: "request-diff",
    label: "Request diff review",
    description: "Hold the write and send evidence to the maintainer queue.",
    impact: "review"
  },
  {
    id: "reject-run",
    label: "Reject run",
    description: "Close the run without mutating GitHub state.",
    impact: "blocked"
  }
];

function buildLiveTests(proof: { before?: string; after?: string; regressions?: string; attempts?: string } | undefined, trace: HarnessTraceEvent[]): DashboardRun["tests"] {
  const safeProof = proof
    ? Object.fromEntries(Object.entries(proof).map(([key, value]) => [key, value ? publicSafeMarkdown(value) : value])) as typeof proof
    : undefined;
  const reproductionLog = trace
    .filter((event) => event.category === "sandbox" && (event.stdout || event.stderr))
    .map((event) => [event.command ? `$ ${event.command}` : undefined, event.stdout, event.stderr].filter(Boolean).join("\n"))
    .join("\n\n")
    .slice(0, 12_000);
  return [
    {
      id: "reproduction",
      label: "Reproduction",
      status: safeProof?.before ? "passed" : "pending",
      detail: compactEvidence(safeProof?.attempts ?? safeProof?.before ?? "Awaiting reproduction evidence", 150),
      log: [safeProof?.before ? boundedMarkdown(safeProof.before, 2_000) : undefined, reproductionLog].filter(Boolean).join("\n\n") || undefined
    },
    {
      id: "after",
      label: "After patch",
      status: safeProof?.after ? "passed" : "pending",
      detail: compactEvidence(safeProof?.after ?? "Awaiting post-patch evidence", 170),
      log: safeProof?.after ? boundedMarkdown(safeProof.after, 2_000) : undefined
    },
    {
      id: "regression",
      label: "Regression suite",
      status: safeProof?.regressions ? "passed" : "pending",
      detail: compactEvidence(safeProof?.regressions ?? "Awaiting regression evidence", 170),
      log: safeProof?.regressions ? boundedMarkdown(safeProof.regressions, 3_000) : undefined
    }
  ];
}

export const happyPathStatuses: RunStatus[] = [
  "received",
  "security-review",
  "triaging",
  "environment-building",
  "reproducing",
  "verified",
  "minimizing",
  "fixing",
  "validating",
  "patch-ready",
  "awaiting-approval",
  "approved",
  "pr-created"
];

export const statusLabels: Record<RunStatus, string> = {
  received: "Received",
  "security-review": "Security review",
  rejected: "Rejected",
  triaging: "Triaging",
  "needs-info": "Needs info",
  failed: "Failed",
  "environment-building": "Environment",
  "environment-failed": "Environment failed",
  reproducing: "Reproducing",
  "not-reproduced": "Not reproduced",
  flaky: "Flaky",
  verified: "Verified",
  minimizing: "Minimizing",
  fixing: "Fixing",
  validating: "Validating",
  "fix-failed": "Fix failed",
  "patch-ready": "Patch ready",
  "awaiting-approval": "Awaiting approval",
  approved: "Approved",
  "pr-created": "PR created"
};

function harnessStatusFor(
  runStatus: RunStatus,
  trueForgeStatus: string,
  resultStatus: string | undefined
): HarnessState["status"] {
  if (trueForgeStatus === "not-configured") return "not-configured";
  if (trueForgeStatus === "failed" || resultStatus === "failed" || runStatus === "failed") return "failed";
  if (runStatus === "awaiting-approval") return "paused";
  if (trueForgeStatus === "completed" || runStatus === "pr-created") return "completed";
  return "running";
}

function currentTaskFor(runStatus: RunStatus, summary?: string): string {
  if (runStatus === "awaiting-approval") return "Waiting for maintainer approval before GitHub mutation";
  if (runStatus === "pr-created") return "Pull request receipt recorded";
  if (runStatus === "failed" || runStatus === "rejected") return summary ?? "Run stopped before repository mutation";
  if (runStatus === "patch-ready" || runStatus === "validating") return "Validating the candidate patch against the reproduction";
  if (runStatus === "reproducing" || runStatus === "verified") return "Reproducing the issue in the Daytona sandbox";
  if (runStatus === "environment-building") return "Preparing the disposable execution environment";
  return "Triaging the GitHub issue";
}

function compactProof(proof: { before?: string; after?: string; regressions?: string; attempts?: string }) {
  return {
    ...(proof.before ? { before: boundedMarkdown(publicSafeMarkdown(proof.before), 1_200) } : {}),
    ...(proof.after ? { after: boundedMarkdown(publicSafeMarkdown(proof.after), 1_200) } : {}),
    ...(proof.regressions ? { regressions: boundedMarkdown(publicSafeMarkdown(proof.regressions), 1_600) } : {}),
    ...(proof.attempts ? { attempts: boundedMarkdown(publicSafeMarkdown(proof.attempts), 300) } : {})
  };
}

function compactEvidence(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return truncateAtBoundary(compact, maxLength);
}

export function truncateAtBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  let prefix = value.slice(0, Math.max(0, maxLength - 3));
  const minimumBoundary = Math.floor(prefix.length * 0.6);
  const boundary = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("."),
    prefix.lastIndexOf(","),
    prefix.lastIndexOf(";")
  );
  if (boundary >= minimumBoundary) prefix = prefix.slice(0, boundary + (prefix[boundary] === "." ? 1 : 0));
  return `${prefix.trimEnd()}...`;
}

function boundedMarkdown(value: string, maxLength: number): string {
  const clean = value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

function publicSafeMarkdown(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/(?:\/tmp|\/workspace|\/home\/[^/\s]+)\/[^\s),;]+/g, "[sandbox path]")
    .replace(/\b[A-Za-z]:\\[^\s),;]+/g, "[local path]")
    .replace(/<[^>\n]*>/g, "")
    .trim();
}

function sanitizeTraceEvent(event: HarnessTraceEvent): HarnessTraceEvent {
  const sanitize = (value: string | undefined) => value
    ? publicSafeMarkdown(value).replace(/\bsession\b/gi, "run").replace(/\bturn\b/gi, "step")
    : undefined;
  return {
    ...event,
    category: event.category === "session" ? "agent" : event.category,
    summary: sanitize(event.summary) ?? "Activity recorded",
    ...(event.target ? { target: sanitize(event.target) } : {}),
    ...(event.command ? { command: sanitize(event.command) } : {}),
    ...(event.stdout ? { stdout: sanitize(event.stdout) } : {}),
    ...(event.stderr ? { stderr: sanitize(event.stderr) } : {}),
    sandboxId: undefined,
    sequenceNumber: undefined,
    mcpServer: undefined
  };
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatWebhookTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}
