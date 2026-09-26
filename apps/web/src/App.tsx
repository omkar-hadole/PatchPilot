import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Cloud,
  Copy,
  FileCode2,
  FileDiff,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Layers3,
  Link2,
  Lock,
  MessageSquareText,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TestTube2,
  User,
  X
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { RunEvent, RunStatus } from "@byter/core";
import { readApprovalSubmission, submitApprovalAction, type ApprovalSubmission } from "./approval-client";
import { MarkdownContent } from "./MarkdownContent";
import {
  fetchDashboardRun,
  statusLabels,
  truncateAtBoundary,
  type ApprovalAction,
  type ApprovalActionId,
  type DashboardRun,
  type HarnessState,
  type HarnessTraceEvent
} from "./data";

type ViewId = "overview" | "trace" | "reproduction" | "patch" | "tests" | "security";

const views: Array<{ id: ViewId; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "trace", label: "Harness trace", icon: Terminal },
  { id: "reproduction", label: "Reproduction", icon: RadioTower },
  { id: "patch", label: "Patch", icon: FileCode2 },
  { id: "tests", label: "Tests", icon: TestTube2 },
  { id: "security", label: "Security", icon: ShieldCheck }
];

function App() {
  const [run, setRun] = useState<DashboardRun | undefined>();
  const reviewRoute = typeof window !== "undefined" && /\/review\/?$/.test(window.location.pathname);
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [pendingAction, setPendingAction] = useState<ApprovalActionId | undefined>();
  const [approval, setApproval] = useState<ApprovalSubmission | undefined>();
  const [approvalError, setApprovalError] = useState<string | undefined>();
  const displayedStatus: RunStatus | undefined = approval?.resultStatus ?? run?.status;

  useEffect(() => {
    void loadRun();
  }, []);

  useEffect(() => {
    if (run?.source !== "webhook") return undefined;
    const refreshTimer = window.setInterval(() => void loadRun(), 5_000);
    return () => window.clearInterval(refreshTimer);
  }, [run?.source]);

  async function loadRun() {
    setIsRefreshing(true);
    setLoadError(undefined);
    try {
      const nextRun = await fetchDashboardRun();
      setRun(nextRun);
      setApproval(readApprovalSubmission(nextRun.id));
      setApprovalError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Run API failed");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  async function handleApproval(actionId: ApprovalActionId) {
    if (!run?.candidatePatch) return;
    setPendingAction(actionId);
    setApprovalError(undefined);
    try {
      const result = await submitApprovalAction({ runId: run.id, actionId, patchHash: run.candidatePatch.hash });
      setApproval(result);
      await loadRun();
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "Approval save failed");
    } finally {
      setPendingAction(undefined);
    }
  }

  if (isLoading) {
    return <StatusScreen icon={<RefreshCw size={22} />} title="Loading Byter run" detail="Connecting to the run record." />;
  }

  if (loadError || !run || !displayedStatus) {
    return (
      <StatusScreen
        icon={<ShieldAlert size={24} />}
        title="Run record unavailable"
        detail={loadError ?? "No persisted run payload was returned."}
        error
        action={
          <button type="button" className="button button-primary" disabled={isRefreshing} onClick={() => void loadRun()}>
            <RefreshCw size={16} aria-hidden="true" />
            {isRefreshing ? "Refreshing" : "Refresh run"}
          </button>
        }
      />
    );
  }

  const currentStatus = displayedStatus;
  const pullRequest = approval?.pullRequest ?? run.pullRequest;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div>
            <p className="eyebrow">Byter run</p>
            <h1>{run.issueTitle}</h1>
            <p className="header-subtitle">{run.repoLabel} <span>/</span> issue #{run.issue.issueNumber}</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`status-pill status-${statusTone(currentStatus)}`}><CircleDot size={12} />{statusLabels[currentStatus]}</span>
          <a className="icon-button" href={run.issue.url} target="_blank" rel="noreferrer" aria-label="Open GitHub issue" title="Open GitHub issue">
            <ArrowUpRight size={17} />
          </a>
          <button type="button" className="icon-button" disabled={isRefreshing} onClick={() => void loadRun()} aria-label="Refresh run" title="Refresh run">
            <RefreshCw size={17} className={isRefreshing ? "spin" : undefined} />
          </button>
        </div>
      </header>

      <section className="run-ribbon" aria-label="Run identity">
        <div className="ribbon-copy"><span className="live-indicator" />{run.sourceLabel}</div>
        <div className="ribbon-links">
          {run.harness.dashboardUrl ? <a href={run.harness.dashboardUrl}><Link2 size={14} />Permanent run URL</a> : undefined}
          {run.harness.statusCommentUrl ? <a href={run.harness.statusCommentUrl} target="_blank" rel="noreferrer"><MessageSquareText size={14} />GitHub updates ({run.harness.commentHistory.length})</a> : undefined}
        </div>
      </section>

      <HarnessPanel harness={run.harness} />

      {reviewRoute ? (
        <ReviewView run={run} currentStatus={currentStatus} pullRequest={pullRequest} approval={approval} approvalError={approvalError} pendingAction={pendingAction} onApproval={handleApproval} />
      ) : <>
        <nav className="view-tabs" aria-label="Run evidence views">
          {views.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={activeView === id ? "active" : undefined} onClick={() => setActiveView(id)} aria-current={activeView === id ? "page" : undefined}>
              <Icon size={16} />{label}
              {id === "trace" ? <span className="tab-count">{run.harness.trace.length}</span> : id === "tests" ? <span className="tab-count">{run.tests.length}</span> : undefined}
            </button>
          ))}
        </nav>

        {activeView === "overview" ? (
        <OverviewView run={run} currentStatus={currentStatus} pullRequest={pullRequest} approval={approval} approvalError={approvalError} pendingAction={pendingAction} onApproval={handleApproval} />
      ) : activeView === "trace" ? (
        <TraceView harness={run.harness} />
      ) : activeView === "reproduction" ? (
        <ReproductionView run={run} />
      ) : activeView === "patch" ? (
        <PatchView run={run} pullRequest={pullRequest} />
      ) : activeView === "tests" ? (
        <TestsView run={run} />
      ) : (
        <SecurityView run={run} />
      )}</>}
    </main>
  );
}

function StatusScreen({ icon, title, detail, error, action }: { icon: ReactNode; title: string; detail: string; error?: boolean; action?: ReactNode }) {
  return <main className="shell center-shell"><section className={`load-state ${error ? "error" : ""}`} role={error ? "alert" : undefined}>{icon}<h1>{title}</h1><p>{detail}</p>{action}</section></main>;
}

function HarnessPanel({ harness }: { harness: HarnessState }) {
  const statusLabel = harness.status === "paused" ? "Paused for approval" : harness.status === "not-configured" ? "Not connected" : harness.status;
  const latestComment = harness.commentHistory.at(-1);
  return (
    <section className={`harness-panel harness-${harness.status}`} aria-label="TrueForge harness">
      <div className="harness-summary">
        <div className="harness-copy">
          <p className="eyebrow">TrueForge activity</p>
          <h2>{harness.currentTask}</h2>
        </div>
        <div className="harness-state"><span className="state-dot" />{statusLabel}</div>
      </div>
      <div className="harness-evidence">
        <span><Layers3 size={15} /><strong>{harness.mcpCalls}</strong> repository calls</span>
        <span><Cloud size={15} /><strong>{harness.sandboxExecutions}</strong> sandbox steps</span>
        <span><Activity size={15} /><strong>{harness.trace.length}</strong> trace events</span>
        {harness.verifiedLabel?.appliedAt ? <span className="label-chip label-valid">valid</span> : undefined}
        {harness.approvalLabel?.appliedAt ? <span className="label-chip label-waiting">waiting approval</span> : undefined}
        {latestComment ? <a href={latestComment.url} target="_blank" rel="noreferrer">Open GitHub update <ArrowUpRight size={13} /></a> : undefined}
      </div>
    </section>
  );
}

function OverviewView({ run, currentStatus, pullRequest, approval, approvalError, pendingAction, onApproval }: { run: DashboardRun; currentStatus: RunStatus; pullRequest?: { number: number; url: string }; approval?: ApprovalSubmission; approvalError?: string; pendingAction?: ApprovalActionId; onApproval: (actionId: ApprovalActionId) => Promise<void> }) {
  const displayedEvents = appendApprovalEvent(run.events, currentStatus, approval);
  return <div className="overview-grid"><Timeline events={displayedEvents} status={currentStatus} /><WhyVerified run={run} /><ApprovalPanel run={run} currentStatus={currentStatus} pullRequest={pullRequest} approval={approval} approvalError={approvalError} pendingAction={pendingAction} onApproval={onApproval} /></div>;
}

function WhyVerified({ run }: { run: DashboardRun }) {
  return (
    <section className="panel why-panel">
      <PanelTitle eyebrow="Verified finding" title="Why this run matters" icon={<ClipboardCheck size={17} />} />
      <div className="finding-callout">
        <ShieldCheck size={20} />
        <div>
          <MarkdownContent value={run.rootCauseSummary ?? compactSummary(run.summary) ?? "Proof summary is still being collected."} className="finding-title" />
          <MarkdownContent value={run.proposedFixSummary ?? run.proof?.before ?? "The harness will place the verified finding here."} />
        </div>
      </div>
      <div className="proof-points">
        <ProofPoint icon={<Terminal size={15} />} label="Regression check" value={briefSummary(run.proof?.regressions) ?? "Not returned yet"} />
        <ProofPoint icon={<RadioTower size={15} />} label="Before / after" value={`${briefSummary(run.proof?.before, 90) ?? "Pending"} → ${briefSummary(run.proof?.after, 90) ?? "Pending"}`} />
      </div>
    </section>
  );
}

function Timeline({ events, status }: { events: RunEvent[]; status: RunStatus }) {
  return <section className="panel timeline-panel"><PanelTitle eyebrow="Run timeline" title="Investigation stages" icon={<Activity size={17} />} /><ol className="timeline-list">{events.map((event, index) => <li key={event.id} className={index === events.length - 1 ? "current" : ""}><span className="timeline-dot">{index === events.length - 1 ? <CircleDot size={13} /> : <Check size={13} />}</span><div><time dateTime={event.at}>{formatTime(event.at)}</time><h3>{statusLabels[event.status]}</h3><p>{event.message}</p></div></li>)}</ol><div className="timeline-current"><span className={`status-dot status-${statusTone(status)}`} />Current: {statusLabels[status]}</div></section>;
}

function ApprovalPanel({ run, currentStatus, pullRequest, approval, approvalError, pendingAction, onApproval }: { run: DashboardRun; currentStatus: RunStatus; pullRequest?: { number: number; url: string }; approval?: ApprovalSubmission; approvalError?: string; pendingAction?: ApprovalActionId; onApproval: (actionId: ApprovalActionId) => Promise<void> }) {
  const patch = run.candidatePatch;
  return (
    <section className="panel approval-panel">
      <PanelTitle eyebrow="Mutation gate" title={pullRequest ? "Draft pull request" : patch ? "TrueForge paused" : "Awaiting proof"} icon={<Lock size={17} />} />
      {patch ? <>
        <div className="approval-request">
          <strong>{pullRequest ? "GitHub write completed" : "Requested action"}</strong>
          <span>{pullRequest ? "The approved patch is now available as a draft PR." : "Create a fix branch, commit the verified patch, and open a draft PR."}</span>
        </div>
        <div className="approval-meta"><span><FileCode2 size={13} />{patch.files.length} files ready for review</span></div>
        <ul className="file-list">{patch.files.map((file) => <li key={file}><FileCode2 size={14} />{file}</li>)}</ul>
        {currentStatus === "awaiting-approval" && !pullRequest ? <>
          <div className="preapproval-state"><ShieldCheck size={17} /><div><strong>Nothing has been written</strong><span>No branch, commit, or pull request exists until a maintainer approves.</span></div></div>
          <GitHubApprovalGuide />
        </> : undefined}
        <div className={`approval-state ${approvalError ? "error" : approval ? "saved" : ""}`} role="status">{approvalError ?? approval?.message ?? (pullRequest ? `Draft PR #${pullRequest.number} recorded` : "Maintainer decision required")}</div>
        {pullRequest ? <a className="button button-success" href={pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequestArrow size={17} />Open draft PR #{pullRequest.number}<ArrowUpRight size={15} /></a> : currentStatus === "awaiting-approval" ? <div className="approval-actions"><p className="control-label">Review decision</p>{run.approvals.map((action) => <ApprovalActionButton key={action.id} action={action} pending={pendingAction === action.id} disabled={pendingAction !== undefined} onClick={onApproval} />)}</div> : undefined}
      </> : <div className="empty-state"><RadioTower size={20} /><p>{run.events.at(-1)?.message ?? "Run is waiting for a candidate proof."}</p></div>}
    </section>
  );
}

function GitHubApprovalGuide() {
  const [copied, setCopied] = useState(false);
  const command = "approve";

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return <details className="github-approval-guide"><summary><strong>Approve from GitHub instead</strong></summary><p>After reviewing the evidence and exact diff, a repository maintainer can post this single word on the issue.</p><div className="github-approval-command"><code>{command}</code><button type="button" className="copy-command" onClick={() => void copyCommand()} aria-label="Copy GitHub approval word" title={copied ? "Copied" : "Copy word"}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div><small>Only maintainers can approve, and the server verifies that the reviewed patch is still current.</small></details>;
}

function ApprovalActionButton({ action, pending, disabled, onClick }: { action: ApprovalAction; pending: boolean; disabled: boolean; onClick: (id: ApprovalActionId) => Promise<void> }) {
  const Icon = action.impact === "safe" ? GitPullRequestArrow : action.impact === "review" ? ClipboardCheck : X;
  return <button type="button" className={`action-button ${action.impact}`} disabled={disabled} onClick={() => void onClick(action.id)} aria-busy={pending}><Icon size={17} /><span>{pending ? "Saving" : action.label}</span><small>{action.description}</small></button>;
}

function TraceView({ harness }: { harness: HarnessState }) {
  return <section className="panel trace-panel"><PanelTitle eyebrow="Executable evidence" title="Harness trace" icon={<Terminal size={17} />} /><div className="trace-intro"><span>{harness.trace.length ? `${harness.trace.length} persisted events` : "No rich events persisted"}</span><span>{harness.status === "paused" ? "checkpoint active" : "updates every 5 seconds"}</span></div>{harness.trace.length ? <ol className="trace-list">{harness.trace.map((event) => <TraceRow key={event.id} event={event} />)}</ol> : <div className="empty-state trace-empty"><Terminal size={22} /><div><strong>Trace details are not available for this run</strong><p>This historical record predates rich event persistence. New runs show tool calls, sandbox commands, and bounded output here.</p></div></div>}</section>;
}

function TraceRow({ event }: { event: HarnessTraceEvent }) {
  const hasOutput = Boolean(event.command || event.stdout || event.stderr);
  return <li className={`trace-row trace-${event.category}`}><div className="trace-icon">{traceIcon(event.category)}</div><div className="trace-main"><div className="trace-topline"><span className="trace-category">{event.category}</span><time dateTime={event.at}>{formatTime(event.at)}</time></div><strong>{event.summary}</strong><div className="trace-details">{event.toolName ? <span>{event.toolName}</span> : undefined}{event.target ? <span>{event.target}</span> : undefined}{event.exitCode !== undefined ? <span className={event.exitCode === 0 ? "text-success" : "text-danger"}>exit {event.exitCode ?? "?"}</span> : undefined}</div>{hasOutput ? <details className="trace-output"><summary><ChevronDown size={14} />Inspect sanitized output</summary>{event.command ? <code>$ {event.command}</code> : undefined}{event.stdout ? <pre>{event.stdout}</pre> : undefined}{event.stderr ? <pre className="stderr">{event.stderr}</pre> : undefined}</details> : undefined}</div></li>;
}

function ReproductionView({ run }: { run: DashboardRun }) {
  const reproduction = run.tests[0];
  const reproEvents = run.harness.trace.filter((event) => event.category === "sandbox" && (event.command || event.stdout || event.stderr));
  return <section className="panel evidence-view"><PanelTitle eyebrow="Proof" title="Reproduction" icon={<RadioTower size={17} />} /><div className="proof-grid"><ProofBlock label="Before patch" value={run.proof?.before ?? "No before-run evidence returned."} tone="failure" /><ProofBlock label="After patch" value={run.proof?.after ?? "No after-run evidence returned."} tone="success" /><ProofBlock label="Regression suite" value={run.proof?.regressions ?? "No regression evidence returned."} tone="neutral" /></div><div className="reproducer-card"><div><p className="eyebrow">Generated reproducer</p><MarkdownContent value={reproduction?.detail ?? "The harness has not returned a reproducer yet."} /></div><span className={`result-badge ${reproduction?.status ?? "pending"}`}>{reproduction?.status ?? "pending"}</span></div>{reproEvents.length ? <details className="raw-evidence"><summary><Terminal size={14} />Inspect sanitized reproducer output</summary>{reproEvents.map((event) => <pre key={event.id}>{[event.command ? `$ ${event.command}` : undefined, event.stdout, event.stderr].filter(Boolean).join("\n")}</pre>)}</details> : undefined}<div className="evidence-note"><AlertTriangle size={16} /><span>Only sanitized command output is shown. Private model reasoning and internal identifiers are omitted.</span></div></section>;
}

function PatchView({ run, pullRequest }: { run: DashboardRun; pullRequest?: { number: number; url: string } }) {
  const patch = run.candidatePatch;
  return (
    <section className="panel evidence-view">
      <PanelTitle eyebrow="Candidate change" title={patch?.title ?? "No candidate patch"} icon={<FileDiff size={17} />} />
      {patch ? <>
        <div className="patch-summary">
          <span><strong>{patch.files.length}</strong> files changed</span>
          <span><strong>Before</strong>{briefSummary(run.proof?.before, 150) ?? "Verified failure"}</span>
          <span><strong>After</strong>{briefSummary(run.proof?.after, 150) ?? "Validated"}</span>
          <span><strong>Regression</strong>{briefSummary(run.proof?.regressions, 150) ?? "Passed"}</span>
        </div>
        {run.proposedFixSummary || patch.body ? <div className="remedy-box"><p className="eyebrow">Proposed remedy</p><MarkdownContent value={run.proposedFixSummary ?? patch.body ?? ""} /></div> : undefined}
        <div className="patch-file-heading"><p className="eyebrow">Exact candidate diff</p><span>{patch.files.length} file{patch.files.length === 1 ? "" : "s"}</span></div>
        <ul className="file-list patch-files">{patch.files.map((file) => <li key={file}><FileCode2 size={14} />{file}</li>)}</ul>
        {run.patchDiff?.length ? <div className="patch-file-list">{run.patchDiff.map((file) => <details className="patch-file" key={file.path} open={run.patchDiff?.length === 1}><summary><FileCode2 size={14} />{file.path}</summary><pre className="diff-code">{unifiedDiff(file.before, file.after)}</pre></details>)}</div> : patch.fileContents?.length ? <div className="patch-file-list">{patch.fileContents.map((file) => <details className="patch-file" key={file.path}><summary><FileCode2 size={14} />{file.path} · proposed content</summary><pre className="patch-file-content">{file.content}</pre></details>)}</div> : undefined}
        {pullRequest ? <a className="button button-success" href={pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequestArrow size={17} />Open draft PR #{pullRequest.number}<ArrowUpRight size={15} /></a> : <div className="preapproval-state"><GitCommitHorizontal size={17} /><div><strong>Write is still gated</strong><span>The candidate patch remains a proposal until approval.</span></div></div>}
      </> : <div className="empty-state"><FileCode2 size={22} /><p>No candidate patch has been returned by the harness.</p></div>}
    </section>
  );
}

function TestsView({ run }: { run: DashboardRun }) {
  return <section className="panel evidence-view"><PanelTitle eyebrow="Validation" title="Tests" icon={<TestTube2 size={17} />} /><div className="test-summary-grid">{run.tests.map((test) => <article className="test-summary" key={test.id}><div><p className="eyebrow">{test.label}</p><MarkdownContent value={test.detail} /></div><span className={`result-badge ${test.status}`}>{test.status}</span></article>)}</div><div className="raw-test-list">{run.tests.map((test) => test.log ? <details key={`${test.id}-log`}><summary><Terminal size={14} />{test.label} evidence</summary><pre>{test.log}</pre></details> : undefined)}</div></section>;
}

function ReviewView({ run, currentStatus, pullRequest, approval, approvalError, pendingAction, onApproval }: { run: DashboardRun; currentStatus: RunStatus; pullRequest?: { number: number; url: string }; approval?: ApprovalSubmission; approvalError?: string; pendingAction?: ApprovalActionId; onApproval: (actionId: ApprovalActionId) => Promise<void> }) {
  return (
    <section className="review-page">
      <div className="review-heading">
        <div><a className="back-link" href={run.harness.dashboardUrl ?? "/"}>← Back to run overview</a><p className="eyebrow">Maintainer review</p><h2>{run.issueTitle}</h2><p>Review the verified evidence and exact candidate change before allowing GitHub writes.</p></div>
      </div>
      <div className="review-grid">
        <section className="panel review-proof">
          <PanelTitle eyebrow="Why verified" title="Evidence at a glance" icon={<ShieldCheck size={17} />} />
          <div className="verification-facts three-up">
            <span><small>Repository</small><strong>{run.repoLabel}</strong></span>
            <span><small>Reproduction</small><strong>{briefSummary(run.proof?.attempts) ?? "Pending"}</strong></span>
            <span><small>Regression</small><strong>{briefSummary(run.proof?.regressions) ?? "Pending"}</strong></span>
          </div>
          <div className="finding-callout"><ShieldCheck size={20} /><div><MarkdownContent value={run.rootCauseSummary ?? compactSummary(run.summary) ?? "The verified finding is being collected."} className="finding-title" /><MarkdownContent value={run.proposedFixSummary ?? "The proposed remedy is available in the patch below."} /></div></div>
        </section>
        <PatchView run={run} pullRequest={pullRequest} />
        <TestsView run={run} />
        <ApprovalPanel run={run} currentStatus={currentStatus} pullRequest={pullRequest} approval={approval} approvalError={approvalError} pendingAction={pendingAction} onApproval={onApproval} />
      </div>
    </section>
  );
}

function SecurityView({ run }: { run: DashboardRun }) {
  const safe = run.security.safeToExecute;
  return <section className="panel evidence-view"><PanelTitle eyebrow="Input policy" title="Security review" icon={safe ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />} /><div className={`security-banner ${safe ? "safe" : "blocked"}`}>{safe ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}<div><strong>{safe ? "Issue cleared for execution" : "Issue held before execution"}</strong><span>{run.security.findings.length} finding{run.security.findings.length === 1 ? "" : "s"} detected</span></div></div>{run.security.findings.length ? <div className="security-findings">{run.security.findings.map((finding) => <article className="security-finding" key={finding.ruleId}><span className={`severity ${finding.severity}`}>{finding.severity}</span><div><h3>{finding.ruleId}</h3><p>{finding.reason}</p><small>Matched issue text is withheld from the public dashboard.</small></div></article>)}</div> : <div className="empty-state"><ShieldCheck size={20} /><p>No prompt-injection or credential-exfiltration findings were recorded.</p></div>}</section>;
}

function PanelTitle({ eyebrow, title, icon }: { eyebrow: string; title: string; icon: ReactNode }) { return <div className="panel-title"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><span className="panel-icon">{icon}</span></div>; }
function ProofPoint({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="proof-point"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>; }
function ProofBlock({ label, value, tone }: { label: string; value: string; tone: string }) { return <article className={`proof-block ${tone}`}><p className="eyebrow">{label}</p><MarkdownContent value={value} /></article>; }

function traceIcon(category: HarnessTraceEvent["category"]) { if (category === "mcp") return <Layers3 size={16} />; if (category === "sandbox") return <Cloud size={16} />; if (category === "subagent") return <User size={16} />; if (category === "github") return <GitPullRequestArrow size={16} />; if (category === "approval") return <Lock size={16} />; if (category === "session") return <Activity size={16} />; return <Bot size={16} />; }
function statusTone(status: RunStatus): string { if (["failed", "rejected", "fix-failed", "environment-failed"].includes(status)) return "danger"; if (["awaiting-approval", "needs-info", "not-reproduced", "flaky"].includes(status)) return "warning"; if (["pr-created", "approved", "verified", "patch-ready"].includes(status)) return "success"; return "active"; }
function formatTime(value: string): string { return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function compactSummary(value?: string): string | undefined { const compact = value?.replace(/\s+/g, " ").trim(); if (!compact) return undefined; const sentence = compact.match(/^.{1,360}?(?:[.!?](?:\s|$)|$)/)?.[0] ?? compact; return truncateAtBoundary(sentence, 380); }
function briefSummary(value?: string, maxLength = 130): string | undefined { const compact = value?.replace(/\s+/g, " ").trim(); return compact ? truncateAtBoundary(compact, maxLength) : undefined; }
function unifiedDiff(before: string, after: string): string { const oldLines = before.split("\n"); const newLines = after.split("\n"); const output = [`--- base`, `+++ proposed`]; const max = Math.max(oldLines.length, newLines.length); for (let index = 0; index < max; index += 1) { const oldLine = oldLines[index]; const newLine = newLines[index]; if (oldLine === newLine && oldLine !== undefined) output.push(`  ${oldLine}`); else { if (oldLine !== undefined) output.push(`- ${oldLine}`); if (newLine !== undefined) output.push(`+ ${newLine}`); } } return output.join("\n"); }
function appendApprovalEvent(events: RunEvent[], status: RunStatus, approval?: ApprovalSubmission): RunEvent[] { return approval ? [...events, { id: approval.id, runId: approval.runId, at: approval.savedAt, status, message: approval.message }] : events; }

export default App;
