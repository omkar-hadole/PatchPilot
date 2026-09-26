import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createByterServer } from "./server.js";

// Auto-load root .env or local .env if present
const rootEnvPath = resolve(process.cwd(), ".env");
if (existsSync(rootEnvPath) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(rootEnvPath);
  } catch {
    // ignore
  }
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

createByterServer().listen(port, "0.0.0.0", () => {
  console.log(`Byter server listening on ${port}`);
});
