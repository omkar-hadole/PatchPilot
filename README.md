# Byter

**CI for bug reports.** Byter turns a GitHub issue into executable proof, a tested candidate fix, and a human-controlled draft pull request.

[Live app](https://byter-production-1024.up.railway.app/) · [Verified run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2) · [Source issue](https://github.com/MAYANK-MAHAUR/Byter/issues/32) · [Local setup guide](Local.md)

![Byter showing a live TrueForge investigation](docs/images/byter-live-overview.png)

## Why Byter

Large repositories receive more bug reports than maintainers can manually reproduce. Byter gives each report the same evidence-first path:

1. Scan the issue as untrusted input.
2. Read scoped repository context through GitHub MCP.
3. Reproduce the failure repeatedly in a disposable Daytona sandbox.
4. Generate a minimal patch and run before, after, and regression checks.
5. Pause before any branch, commit, or pull request is created.
6. Continue only when a maintainer approves on the dashboard or replies `approve` on GitHub.

## TrueForge In The Loop

TrueForge is the durable harness behind every live run. It starts the model turn, connects the GitHub MCP tools, provisions sandbox execution, records observable events, returns the structured proof contract that drives Byter's UI, and pauses `create_fix_pull_request` through its native tool-approval event before any repository mutation. Byter has no alternate local runner or fixture-data API.

The public [issue #32 run](https://byter-production-1024.up.railway.app/runs/github-MAYANK-MAHAUR-Byter-32-8fd16ca98fd2) is real: 57 persisted events, 11 repository-tool events, 22 sandbox events, a 3/3 reproduction, a passing candidate patch, and regression proof. It is intentionally paused at `awaiting-approval`.

| Observable harness trace | Review before repository writes |
| :--- | :--- |
| ![GitHub MCP and Daytona activity](docs/images/byter-harness-trace.png) | ![Candidate patch and approval gate](docs/images/byter-review-gate.png) |

Byter shows what the agent did, what evidence it produced, and what it is waiting for. It does not expose private chain-of-thought, credentials, internal provider IDs, or raw infrastructure paths.

## Safety Boundary

- Signed webhook intake and prompt-injection scanning.
- Scoped GitHub tools and bounded sandbox output.
- Secret, path, and provider-detail redaction before public persistence.
- Repeated failure proof plus after-patch and regression validation.
- TrueForge-native maintainer approval before branch, commit, or pull-request creation; approval resumes the exact pending MCP tool call and opens a draft PR.

## Qodo Code Review Evidence

Qodo reviewed the project across every focused pull request while it was being built. We fixed valid findings and requested follow-up reviews instead of treating code review as a one-time badge.

Below is a representative inventory of pull requests reviewed by Qodo throughout the build:

<details open>
<summary><strong>Core Architecture & Hardening PRs (Featured)</strong></summary>

<br/>

<details open>
<summary><strong>PR #23: Add live TrueForge harness visibility (Merged)</strong></summary>

- **Pull Request**: [#23 (feat/harness-visibility)](https://github.com/MAYANK-MAHAUR/Byter/pull/23)
- **Detailed Qodo Review**: [Review comment #5462238474](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5462238474)
- **Follow-up Review Confirmation**: [Confirmation comment #5468354710](https://github.com/MAYANK-MAHAUR/Byter/pull/23#issuecomment-5468354710)
- **Key Findings Identified**: 10 distinct issues surfaced by Qodo, including standing label re-trigger loops, secret/token leakage in agent summaries, non-unique run URLs, unredacted tool filesystem paths, host header poisoning in dashboard links, and unbuffered JSONL memory growth during polling.
- **Remediations Applied**: Implemented public-data normalization, trusted base URL validation, strict redaction of raw system paths and provider tokens, streaming JSONL readers, event identity deduplication, and regression tests.
- **Outcome**: Follow-up review confirmed: *"No active findings remain for this PR."*
</details>

<details open>
<summary><strong>PR #14: Feat: start TrueForge sessions from webhooks (Merged)</strong></summary>

- **Pull Request**: [#14 (codex/live-trueforge-webhook-handoff)](https://github.com/MAYANK-MAHAUR/Byter/pull/14)
- **Detailed Qodo Review**: [Review comment #5456012431](https://github.com/MAYANK-MAHAUR/Byter/pull/14#issuecomment-5456012431)
- **Key Findings Identified**: Unbounded webhook orchestration timeouts stalling incoming requests, and dropped partial-failure session metadata (`TrueForgeInitialTurnError`) during startup failures.
- **Remediations Applied**: Added finite session startup timeout boundaries, explicit `TrueForgeInitialTurnError` recovery preservation, and durable failed-state persistence with session cleanup.
</details>

<details open>
<summary><strong>PR #2: Add GitHub integration plumbing (Merged)</strong></summary>

- **Pull Request**: [#2 (feat/github-integration)](https://github.com/MAYANK-MAHAUR/Byter/pull/2)
- **Detailed Qodo Review**: [Review comment #5442012351](https://github.com/MAYANK-MAHAUR/Byter/pull/2#issuecomment-5442012351)
- **Key Findings Identified**: Potential REST URL path traversal via unencoded repo/owner identifiers (`..` path segments) and approval payload binding bypass.
- **Remediations Applied**: Added strict identifier format validation, URL segment encoding, and cryptographic payload hash binding to prevent replaying approvals for unintended write operations.
</details>

</details>

<details>
<summary><strong>Complete Qodo PR Review Trail (Click to expand all 18 PRs)</strong></summary>

<br/>

<details>
<summary><strong>PR #31: Polish the README with live Byter evidence (Merged)</strong></summary>

- **Pull Request**: [#31 (docs/readme-polish)](https://github.com/MAYANK-MAHAUR/Byter/pull/31)
- **Review URL**: [Qodo Review #5468495704](https://github.com/MAYANK-MAHAUR/Byter/pull/31#issuecomment-5468495704) · [Follow-up #5468500966](https://github.com/MAYANK-MAHAUR/Byter/pull/31#issuecomment-5468500966)
- **Findings & Actions**: Flagged discrepancy between telemetry metrics and advertised integrations. Realigned documentation strictly with verified live run telemetry (57 persisted events, 11 repository-tool events, 22 sandbox events, 3/3 repro).
</details>

<details>
<summary><strong>PR #20: Connect dashboard to live API (Merged)</strong></summary>

- **Pull Request**: [#20 (codex/live-dashboard-api)](https://github.com/MAYANK-MAHAUR/Byter/pull/20)
- **Review URL**: [Qodo Review #5460648027](https://github.com/MAYANK-MAHAUR/Byter/pull/20#issuecomment-5460648027)
- **Findings & Actions**: Verified live API proxy routing, runtime contract parsing, and maintainer approval endpoint security.
</details>

<details>
<summary><strong>PR #19: Expose GitHub tools through remote MCP (Merged)</strong></summary>

- **Pull Request**: [#19 (codex/remote-github-mcp)](https://github.com/MAYANK-MAHAUR/Byter/pull/19)
- **Review URL**: [Qodo Review #5460594069](https://github.com/MAYANK-MAHAUR/Byter/pull/19#issuecomment-5460594069)
- **Findings & Actions**: Verified MCP authentication token requirements and scoped tool sandboxing.
</details>

<details>
<summary><strong>PR #18: Refresh live dashboard runs (Merged)</strong></summary>

- **Pull Request**: [#18 (codex/dashboard-live-polling)](https://github.com/MAYANK-MAHAUR/Byter/pull/18)
- **Review URL**: [Qodo Review #5460518546](https://github.com/MAYANK-MAHAUR/Byter/pull/18#issuecomment-5460518546)
- **Findings & Actions**: Verified polling interval bounds, client hydration efficiency, and stream event deduplication.
</details>

<details>
<summary><strong>PR #17: Persist TrueForge turn events (Merged)</strong></summary>

- **Pull Request**: [#17 (codex/trueforge-turn-event-monitor)](https://github.com/MAYANK-MAHAUR/Byter/pull/17)
- **Review URL**: [Qodo Review #5460504073](https://github.com/MAYANK-MAHAUR/Byter/pull/17#issuecomment-5460504073)
- **Findings & Actions**: Verified durability of asynchronous event persistence and sequence ordering during long-running agent turns.
</details>

<details>
<summary><strong>PR #16: Show persisted webhook runs in dashboard (Merged)</strong></summary>

- **Pull Request**: [#16 (codex/dashboard-live-webhook-runs)](https://github.com/MAYANK-MAHAUR/Byter/pull/16)
- **Review URL**: [Qodo Review #5460470113](https://github.com/MAYANK-MAHAUR/Byter/pull/16#issuecomment-5460470113)
- **Findings & Actions**: Verified JSONL read boundaries and data integrity for public run views.
</details>

<details>
<summary><strong>PR #15: Fix: harden webhook request handling (Superseded into #23)</strong></summary>

- **Pull Request**: [#15 (codex/qodo-release-hardening)](https://github.com/MAYANK-MAHAUR/Byter/pull/15)
- **Review URL**: [Qodo Review #5456021095](https://github.com/MAYANK-MAHAUR/Byter/pull/15#issuecomment-5456021095)
- **Findings & Actions**: Surfaced in-memory delivery lock lifecycle and claim file unbounded growth; resolved via unified active trigger sets and lookback windows.
</details>

<details>
<summary><strong>PR #13: Chore: add release readiness audit (Merged)</strong></summary>

- **Pull Request**: [#13 (chore/release-readiness-audit)](https://github.com/MAYANK-MAHAUR/Byter/pull/13)
- **Findings & Actions**: Audited pre-flight release readiness contracts, documentation completeness, and workspace script alignment.
</details>

<details>
<summary><strong>PR #6: Dashboard console (Merged)</strong></summary>

- **Pull Request**: [#6 (feat/dashboard-console)](https://github.com/MAYANK-MAHAUR/Byter/pull/6)
- **Findings & Actions**: Validated high-contrast monochrome console styling and ANSI terminal sequence sanitization.
</details>

<details>
<summary><strong>PR #5: Add patch validation proof (Merged)</strong></summary>

- **Pull Request**: [#5 (feat/patch-validation)](https://github.com/MAYANK-MAHAUR/Byter/pull/5)
- **Findings & Actions**: Validated 3-phase patch verification (Before ❌, After ✅, Regressions ✅) and isolated temporary workspace symlink traversal guards.
</details>

<details>
<summary><strong>PR #4: Add reproduction verification engine (Merged)</strong></summary>

- **Pull Request**: [#4 (feat/reproduction-engine)](https://github.com/MAYANK-MAHAUR/Byter/pull/4)
- **Findings & Actions**: Enforced 3/3 repeated deterministic reproduction requirements and error fingerprint matching.
</details>

<details>
<summary><strong>PR #3: Add TrueForge runtime adapter (Merged)</strong></summary>

- **Pull Request**: [#3 (feat/trueforge-runtime)](https://github.com/MAYANK-MAHAUR/Byter/pull/3)
- **Findings & Actions**: Built TrueForge session management, turn event streaming, and structured proof contract validation.
</details>

<details>
<summary><strong>PR #1: Add ReproSmith foundation (Merged)</strong></summary>

- **Pull Request**: [#1 (feat/foundation)](https://github.com/MAYANK-MAHAUR/Byter/pull/1)
- **Findings & Actions**: Established pnpm monorepo structure, state machine foundation, and security boundary schemas.
</details>

</details>

## Run Locally

[Local.md](Local.md)

## Project Map

```text
apps/server          webhooks, persistence, approvals, and public API
apps/web             live harness and evidence dashboard
apps/github-mcp      scoped repository tools and approved writes
packages/agent       TrueForge runtime and structured proof contract
packages/core        run state machine and issue security scanning
packages/github      signed webhooks, GitHub App auth, and REST client
```

Built for the [TrueForge Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge).

## AI Usage Disclosure

OpenAI Codex and other AI coding assistants supported implementation, testing, and documentation. The maintainer reviewed the resulting changes, and substantive pull requests were reviewed with Qodo before merge.
