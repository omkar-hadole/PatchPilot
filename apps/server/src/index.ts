import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPatchPilotServer } from "./server.js";

// Always resolve .env relative to the repo root (this file's location),
// not process.cwd() -- `pnpm --filter @patchpilot/server start` runs with
// cwd=apps/server, so a cwd-relative lookup would silently read a
// different, stale apps/server/.env instead of the repo's real one.
const repoRootEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
const envPath = existsSync(repoRootEnvPath) ? repoRootEnvPath : resolve(process.cwd(), ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // ignore
  }
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

createPatchPilotServer().listen(port, "0.0.0.0", () => {
  console.log(`PatchPilot server listening on ${port}`);
});
