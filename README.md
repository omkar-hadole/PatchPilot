# PatchPilot

**CI for bug reports.** PatchPilot turns a GitHub issue into executable proof, a tested candidate fix, and a human-controlled draft pull request — powered by its own coding-agent harness, not a third-party agent framework.

[Local setup guide](Local.md)

## Why PatchPilot

Large repositories receive more bug reports than maintainers can manually reproduce. PatchPilot gives each report the same evidence-first path:

1. Scan the issue as untrusted input.
2. Read scoped repository context through GitHub MCP tools.
3. Reproduce the failure repeatedly in a sandbox workspace.
4. Generate a minimal patch and run before, after, and regression checks.
5. Pause before any branch, commit, or pull request is created.
6. Continue only when a maintainer approves.

## The Harness

The coding-agent harness in `packages/agent` is PatchPilot's own — it calls the configured model directly (any OpenAI-compatible endpoint, via `AI_API_KEY`), executes GitHub MCP tools and sandbox commands in-process, manages conversation context so a run doesn't outgrow the model's token budget, recovers from malformed model output and rate limits instead of failing outright, and pauses `create_fix_pull_request` for maintainer approval before any repository mutation. There is no dependency on an external agent-orchestration service.

PatchPilot shows what the agent did, what evidence it produced, and what it is waiting for. It does not expose private chain-of-thought, credentials, internal provider IDs, or raw infrastructure paths.

## Safety Boundary

- Signed webhook intake and prompt-injection scanning on incoming issue text.
- Scoped GitHub tools and bounded sandbox output.
- Secret, path, and provider-detail redaction before public persistence.
- Repeated failure proof plus after-patch and regression validation before a fix is considered verified.
- Maintainer approval required before any branch, commit, or pull-request write; approval is bound to the exact proposed patch via a payload hash.

**Current limitation:** the sandbox (`packages/agent/src/sandbox.ts`) currently runs commands in a plain temp directory on the host process, not a container or VM. It is not yet safe to point at untrusted, arbitrary GitHub issues in production — hardening this (Docker or a managed sandbox provider) is planned before that use case.

## Run Locally

[Local.md](Local.md)

## Project Map

```text
apps/server          webhooks, persistence, approvals, and public API
apps/web             live harness and evidence dashboard
apps/github-mcp      scoped repository tools and approved writes
packages/agent       PatchPilot's own coding-agent harness (model client, tool loop, sandbox, context management)
packages/core        run state machine and issue security scanning
packages/github      signed webhooks, GitHub App auth, and REST client
```

## Origin

PatchPilot started as a fork of [Byter](https://github.com/MAYANK-MAHAUR/Byter) by Mayank Mahaur, built for the [WeMakeDevs TrueForge Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge), used here with permission. The webhook intake, security scanning, GitHub MCP tools, approval-gating logic, and dashboard originate from that project. The core difference: Byter's agent loop ran on `@truefoundry/trueforge-sdk`, an external harness; PatchPilot replaces that with its own harness in `packages/agent`, since building that orchestration layer is the point of the hackathon this project now targets.

## Status

The harness has been verified against a real model and a real GitHub issue: it correctly read the issue and target file, reproduced the seeded bug (an exact `TypeError` match), applied a fix, and confirmed the fix resolved it — all through its own tool-calling loop, with real recovery from a malformed tool call and provider rate limits along the way. Full end-to-end runs (through to a maintainer-approved pull request) are still being exercised against free-tier model rate limits; the approval-gated write path itself is covered by unit tests.

## AI Usage Disclosure

This project's harness, tests, and documentation were built with AI pair-programming assistance (Claude). Changes were reviewed and verified by the maintainer, including real runs against a live model and GitHub repository rather than relying on test coverage alone.
