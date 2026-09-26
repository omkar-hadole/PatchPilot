import { describe, expect, it } from "vitest";
import { GitHubRestClient } from "../src/index.js";

describe("GitHubRestClient", () => {
  it("uses GitHub REST headers and encodes content path segments", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ path: "src/file name.ts", sha: "abc", encoding: "base64", content: "YQ==" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const client = new GitHubRestClient({
      token: "token",
      apiBaseUrl: "https://api.github.test",
      fetchImpl
    });

    await client.getFile("owner-name", "repo.name", "src/file name?#.ts", "main");

    expect(calls[0]?.url).toBe(
      "https://api.github.test/repos/owner-name/repo.name/contents/src/file%20name%3F%23.ts?ref=main"
    );
    expect((calls[0]?.init.headers as Record<string, string>)["User-Agent"]).toBe("Byter/0.1.0");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("rejects owner or repo values that would escape REST path segments", async () => {
    const client = new GitHubRestClient({
      token: "token",
      fetchImpl: (() => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    await expect(client.getIssue("owner/name", "repo", 1)).rejects.toThrow("Invalid GitHub owner");
    await expect(client.getIssue("owner", "repo/name", 1)).rejects.toThrow("Invalid GitHub repository name");
  });

  it("rejects traversal repository paths before making a request", async () => {
    const client = new GitHubRestClient({
      token: "token",
      fetchImpl: (() => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    await expect(client.getFile("owner", "repo", "../issues/1")).rejects.toThrow("Invalid GitHub repository path");
    await expect(client.getFile("owner", "repo", "src/../token")).rejects.toThrow(
      "Invalid GitHub repository path"
    );
    await expect(client.getFile("owner", "repo", "/src/token.ts")).rejects.toThrow("Invalid GitHub repository path");
  });

  it("creates a fix tree commit, branch, and draft pull request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/branches/main")) {
        return new Response(JSON.stringify({ name: "main", commit: { sha: "a".repeat(40) } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return new Response(JSON.stringify({ sha: "a".repeat(40), tree: { sha: "b".repeat(40) } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith("/git/trees")) {
        return new Response(JSON.stringify({ sha: "c".repeat(40) }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith("/git/commits")) {
        return new Response(JSON.stringify({ sha: "d".repeat(40), tree: { sha: "c".repeat(40) } }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith("/pulls")) {
        return new Response(JSON.stringify({ number: 12, html_url: "https://github.test/pull/12" }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });
    const branch = await client.getBranch("owner", "repo", "main");
    const baseCommit = await client.getCommit("owner", "repo", branch.commit.sha);
    const tree = await client.createTree("owner", "repo", {
      baseTree: baseCommit.tree.sha,
      files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
    });
    const commit = await client.createCommit("owner", "repo", {
      message: "Byter fix: trailing escape",
      tree: tree.sha,
      parents: [branch.commit.sha]
    });
    await client.createBranch("owner", "repo", "byter/fix-17", commit.sha);
    const pullRequest = await client.createPullRequest("owner", "repo", {
      title: "Fix trailing escape",
      body: "Verified by Byter.",
      head: "byter/fix-17",
      base: "main"
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.test/repos/owner/repo/branches/main",
      `https://api.github.test/repos/owner/repo/git/commits/${"a".repeat(40)}`,
      "https://api.github.test/repos/owner/repo/git/trees",
      "https://api.github.test/repos/owner/repo/git/commits",
      "https://api.github.test/repos/owner/repo/git/refs",
      "https://api.github.test/repos/owner/repo/pulls"
    ]);
    expect(JSON.parse(calls[2]?.init.body as string)).toMatchObject({
      base_tree: "b".repeat(40),
      tree: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
    });
    expect(JSON.parse(calls[3]?.init.body as string)).toMatchObject({
      tree: "c".repeat(40),
      parents: ["a".repeat(40)]
    });
    expect(JSON.parse(calls[4]?.init.body as string)).toMatchObject({
      ref: "refs/heads/byter/fix-17",
      sha: "d".repeat(40)
    });
    expect(JSON.parse(calls[5]?.init.body as string)).toMatchObject({ draft: true });
    expect(pullRequest.html_url).toBe("https://github.test/pull/12");
  });

  it("deletes created branches through the refs API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    await client.deleteBranch("owner", "repo", "byter/fix-17");

    expect(calls[0]?.url).toBe("https://api.github.test/repos/owner/repo/git/refs/heads/byter/fix-17");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("creates a verified label through the repository labels API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    await client.createLabel("owner", "repo", "byter:verified", "8250df", "Issue verified by reproducible evidence");

    expect(calls[0]?.url).toBe("https://api.github.test/repos/owner/repo/labels");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      name: "byter:verified",
      color: "8250df",
      description: "Issue verified by reproducible evidence"
    });
  });

  it("reads collaborator permissions and removes issue labels", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ permission: "maintain" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    await expect(client.getCollaboratorPermission("owner", "repo", "maintainer-name")).resolves.toEqual({ permission: "maintain" });
    await client.removeLabel("owner", "repo", 17, "byter:awaiting-approval");

    expect(calls[0]?.url).toBe("https://api.github.test/repos/owner/repo/collaborators/maintainer-name/permission");
    expect(calls[1]?.url).toBe("https://api.github.test/repos/owner/repo/issues/17/labels/byter%3Aawaiting-approval");
    expect(calls[1]?.init.method).toBe("DELETE");
  });
});
