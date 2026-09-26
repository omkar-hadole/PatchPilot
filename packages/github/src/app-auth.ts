import { createSign } from "node:crypto";

export interface GitHubAppJwtOptions {
  appId: string;
  privateKey: string;
  now?: Date;
}

export interface InstallationTokenOptions extends GitHubAppJwtOptions {
  installationId: number;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function createGitHubAppJwt({ appId, privateKey, now = new Date() }: GitHubAppJwtOptions): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: issuedAt, exp: expiresAt, iss: appId };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(normalizePrivateKey(privateKey));

  return `${signingInput}.${base64Url(signature)}`;
}

export async function createInstallationAccessToken(
  options: InstallationTokenOptions
): Promise<InstallationTokenResponse> {
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const jwt = createGitHubAppJwt(options);
  const response = await fetchImpl(
    `${apiBaseUrl}/app/installations/${options.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "User-Agent": "Byter/0.1.0",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub installation token request failed: ${response.status} ${text}`);
  }

  return (await response.json()) as InstallationTokenResponse;
}

export function normalizePrivateKey(privateKey: string): string {
  return privateKey.replaceAll("\\n", "\n");
}
