# Running PatchPilot Locally

PatchPilot is a single Node.js/TypeScript service: a webhook receiver, a coding-agent harness, a GitHub MCP tool server, and a dashboard, all in one process. It calls out to your configured model over HTTPS — there is no second local service to run (older forks of this project used TrueForge as a separate service; PatchPilot's harness runs in-process instead).

## 1. Prerequisites

| Prerequisite | Minimum Version | Verification | Notes |
| :--- | :--- | :--- | :--- |
| Node.js | `^20.19.0` or `>=22.12.0` | `node -v` | Node 22+ recommended |
| pnpm | `>=10.0.0` | `pnpm -v` | `corepack enable pnpm` if missing |
| An AI API key | — | — | Any OpenAI-compatible endpoint with tool-calling support (OpenAI, Groq, Gemini's OpenAI-compatible endpoint, etc.) |
| GitHub token | `ghp_...` or a fine-grained PAT | — | Needs read/write on issues, contents, and pull requests for the target repo |

## 2. Clone and install

```bash
git clone <your-fork-url>
cd PatchPilot
pnpm install
pnpm build
```

Or use the Makefile, which does both:

```bash
make setup
```

## 3. Configure `.env`

```bash
cp .env.example .env
```

Fill in the values that matter for your use case:

| Variable | Purpose | Required for |
| :--- | :--- | :--- |
| `AI_API_KEY` | Your model provider's API key | Any live run |
| `AI_BASE_URL` | OpenAI-compatible base URL (default: `https://api.openai.com/v1`) | Non-OpenAI providers |
| `AI_MODEL` | Model name your key has access to, with tool-calling support | Any live run |
| `GITHUB_TOKEN` | Token for reading issues/files and writing branches/PRs | Any live run |
| `PORT`, `DATA_DIR`, `APP_BASE_URL` | Local server config | Running the server |
| `APPROVAL_TOKEN` | Bearer token for the dashboard's approve/reject API | Approving via dashboard |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for verifying real GitHub webhook deliveries | Live GitHub webhook intake |
| `PATCHPILOT_REQUIRE_TRIGGER_LABEL`, `PATCHPILOT_TRIGGER_LABEL` | Only triage issues carrying this label | Live GitHub webhook intake |
| `MCP_AUTH_TOKEN` | Bearer token for the standalone `/mcp` HTTP endpoint | Only if something external needs to call `/mcp` directly |

## 4. Two ways to run it

### Option A — the fastest way to see the harness work: `scripts/smoke-test.ts`

This bypasses webhooks and the dashboard entirely and drives the harness directly against one GitHub issue, printing every event to your terminal and prompting `y/N` before any GitHub write:

```bash
export SMOKE_OWNER=<your-github-username>
export SMOKE_REPO=<your-repo>
export SMOKE_ISSUE=<issue-number>
node --experimental-strip-types scripts/smoke-test.ts
```

It auto-loads `.env` if present, so as long as `AI_API_KEY` and `GITHUB_TOKEN` are set there, you don't need to export them separately.

### Option B — the real product: webhook-driven server + dashboard

```bash
make run
```

or directly:

```bash
pnpm start
```

This starts the full server (default `http://127.0.0.1:8787`), which serves the dashboard, accepts GitHub webhooks at `/api/github/webhook`, and exposes `/api/approvals` for the approve/reject flow. Open it in a browser to see the dashboard; it will show "no run available" until a webhook fires.

To receive real GitHub webhooks locally, GitHub can't reach `localhost` directly — forward them with a tunnel:

```bash
npx smee -u https://smee.io/<your-channel-id> --target http://127.0.0.1:8787/api/github/webhook
```

Then, on your GitHub repo, add a webhook pointing at your Smee channel URL, content type `application/json`, secret matching `GITHUB_WEBHOOK_SECRET`, subscribed to `Issues` and `Issue comments`.

## 5. What happens on a real run

1. An issue is opened (or labeled, if `PATCHPILOT_REQUIRE_TRIGGER_LABEL=true`) and PatchPilot receives the webhook.
2. The security scanner (`packages/core/src/security.ts`) screens the issue text for prompt-injection and dangerous-command patterns before anything runs.
3. The harness (`packages/agent`) reads the issue and relevant files via GitHub MCP tools, reproduces the bug in the sandbox, and — once it has a fix that passes 3/3 before/after/regression checks — calls `submit_patchpilot_result` followed by `create_fix_pull_request`.
4. The harness pauses there. You approve or reject via the dashboard (`POST /api/approvals` with `APPROVAL_TOKEN`) or by commenting `approve` on the GitHub issue (if you have write access to the repo).
5. On approval, PatchPilot creates the branch, commits the fix, and opens a draft pull request.

## 6. Known limitations to be aware of

- **Sandbox isolation**: `packages/agent/src/sandbox.ts` currently runs shell commands in a plain temp directory on the host process — not a container or VM. Fine for testing against issues you trust; not yet safe for arbitrary untrusted issues.
- **Free-tier model rate limits**: small free-tier token-per-minute budgets (e.g. Groq's free tier) can make a run slow, since the harness correctly waits out rate limits rather than failing — but a long-running conversation can still eventually exceed a very small per-request budget. Context compaction (`packages/agent/src/harness-runtime.ts`) reduces this but doesn't eliminate it on the smallest free tiers.

## 7. Troubleshooting

**`401 Invalid signature` on webhook delivery** — the secret in your GitHub webhook settings doesn't match `GITHUB_WEBHOOK_SECRET` in `.env`, character-for-character.

**`Missing required environment variable` from `scripts/smoke-test.ts`** — `.env` doesn't exist, or is missing `AI_API_KEY`/`GITHUB_TOKEN`; copy `.env.example` and fill it in.

**`Model request failed (404)` / `model_not_found`** — the model name in `AI_MODEL` isn't available to your key. List what's available: `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $AI_API_KEY"` (adjust the base URL for your provider), and pick one whose feature list includes tool calling.

**`Model request failed (429)`** — normal on constrained free tiers; the harness waits and retries automatically. If it keeps happening, switch to a smaller/cheaper model or a provider with a higher token-per-minute limit.

**Security scanner rejects the issue (`safeToExecute: false`)** — the issue text tripped a prompt-injection or dangerous-command heuristic. Review the issue body for suspicious phrasing (requests to dump secrets, base64-obfuscated commands, etc.).

**Approval comment ignored** — the commenter needs `OWNER`, `admin`, `maintain`, or `write` permission on the repository; otherwise approve through the dashboard with `APPROVAL_TOKEN`.
