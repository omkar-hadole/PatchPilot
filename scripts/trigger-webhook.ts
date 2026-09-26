// Sends a signed GitHub-style webhook to the local PatchPilot server
// to trigger a real harness run against omkar-hadole/PatchPilot#1.

import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(envPath); } catch {}
}

const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "replace-with-your-github-webhook-secret";
const port = process.env.PORT ?? "8787";

const payload = JSON.stringify({
  action: "opened",
  issue: {
    number: 1,
    title: "tokenizePattern crashes on a trailing backslash",
    body: "## Description\n\n`tokenizePattern` in `demo/buggy-parser/src/tokenizer.ts` crashes with `TypeError: Cannot read properties of undefined (reading 'toLowerCase')` when the input pattern ends with a trailing backslash (`\\\\`).\n\n## Steps to reproduce\n\n```ts\nimport { tokenizePattern } from './src/index.js';\ntokenizePattern('\\\\');\n```\n\n## Expected behavior\n\nThe function should either treat a trailing backslash as a literal character or throw a descriptive error.\n\n## Actual behavior\n\n```\nTypeError: Cannot read properties of undefined (reading 'toLowerCase')\n```\n\n## Environment\n\n- Node.js 22\n- TypeScript with `--experimental-strip-types`",
    html_url: "https://github.com/omkar-hadole/PatchPilot/issues/1",
    labels: [{ name: "patchpilot:run" }]
  },
  repository: {
    name: "PatchPilot",
    full_name: "omkar-hadole/PatchPilot",
    default_branch: "main",
    owner: { login: "omkar-hadole" }
  }
});

const signature = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
const deliveryId = randomUUID();

console.log(`Sending webhook to http://127.0.0.1:${port}/api/github/webhook`);
console.log(`Delivery ID: ${deliveryId}`);
console.log(`Signature: ${signature.slice(0, 20)}...`);

const response = await fetch(`http://127.0.0.1:${port}/api/github/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-GitHub-Event": "issues",
    "X-GitHub-Delivery": deliveryId,
    "X-Hub-Signature-256": signature,
  },
  body: payload,
});

const body = await response.text();
console.log(`\nResponse: ${response.status} ${response.statusText}`);
console.log(body);
