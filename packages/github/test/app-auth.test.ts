import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGitHubAppJwt,
  createInstallationAccessToken,
  normalizePrivateKey
} from "../src/index.js";

describe("GitHub App auth", () => {
  it("creates a three-part RS256 JWT", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    const jwt = createGitHubAppJwt({
      appId: "123",
      privateKey: pem,
      now: new Date("2026-08-27T12:00:00.000Z")
    });

    expect(jwt.split(".")).toHaveLength(3);
  });

  it("normalizes escaped private keys from environment variables", () => {
    expect(normalizePrivateKey("line1\\nline2")).toBe("line1\nline2");
  });

  it("requests an installation token with GitHub API headers", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ token: "installation-token", expires_at: "2026-08-27T13:00:00Z" }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const token = await createInstallationAccessToken({
      appId: "123",
      privateKey: pem,
      installationId: 456,
      apiBaseUrl: "https://api.github.test",
      fetchImpl
    });

    expect(token.token).toBe("installation-token");
    expect(calls[0]?.url).toBe("https://api.github.test/app/installations/456/access_tokens");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });
});
