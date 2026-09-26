import { describe, expect, it, vi } from "vitest";
import { approvalPayloadHash, createGitHubMcpTools, listGitHubTools } from "../src/index.js";

describe("GitHub MCP tools", () => {
  it("exposes read and approved write tools", () => {
    expect(listGitHubTools()).toEqual([
      expect.objectContaining({ name: "read_issue", requiresApproval: false }),
      expect.objectContaining({ name: "read_file", requiresApproval: false }),
      expect.objectContaining({ name: "submit_byter_result", requiresApproval: false }),
      expect.objectContaining({ name: "add_verified_label", requiresApproval: true }),
      expect.objectContaining({ name: "comment_on_issue", requiresApproval: true }),
      expect.objectContaining({ name: "create_fix_pull_request", requiresApproval: true })
    ]);
  });

  it("reads issues through the GitHub client", async () => {
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        number: 3,
        title: "Bug",
        body: "Breaks",
        state: "open",
        html_url: "https://github.test/issue/3"
      })
    };
    const tools = createGitHubMcpTools({ client: client as never });

    const result = await tools.callTool({
      name: "read_issue",
      arguments: { owner: "o", repo: "r", issueNumber: 3 }
    });

    expect(client.getIssue).toHaveBeenCalledWith("o", "r", 3);
    expect(result.content[0]?.text).toContain("\"title\": \"Bug\"");
  });

  it("accepts a proof contract without calling GitHub", async () => {
    const client = { createIssueComment: vi.fn(), addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    const result = await tools.callTool({
      name: "submit_byter_result",
      arguments: {
        kind: "byter.result",
        status: "blocked",
        summary: "The sandbox runtime was unavailable.",
        proof: { before: "not run", after: "not run", regressions: "not run", attempts: "0/3" },
        candidatePatch: null
      }
    });

    expect(result.content[0]?.text).toContain("\"accepted\":true");
    expect(client.createIssueComment).not.toHaveBeenCalled();
    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("rejects placeholder proof before it can reach approval", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    await expect(tools.callTool({
      name: "submit_byter_result",
      arguments: {
        kind: "byter.result",
        status: "patch-ready",
        summary: "...",
        proof: { before: "...", after: "...", regressions: "...", attempts: "3/3" },
        candidatePatch: {
          title: "...",
          body: "...",
          files: [{ path: "src/file.ts", content: "full file content" }]
        }
      }
    })).rejects.toThrow("concrete non-placeholder text argument: summary");
  });

  it("blocks writes without approval", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 3 }
      })
    ).rejects.toThrow("approval is required");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("blocks writes without a payload-specific approval hash", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 3 },
        approval: { approved: true }
      })
    ).rejects.toThrow("approval payload hash is required");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("blocks writes when approval was for a different payload", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });
    const hashForIssueThree = approvalPayloadHash("add_verified_label", {
      owner: "o",
      repo: "r",
      issueNumber: 3
    });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 4 },
        approval: { approved: true, expectedPayloadHash: hashForIssueThree }
      })
    ).rejects.toThrow("approval payload hash mismatch");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("allows writes with a matching payload-specific approval hash", async () => {
    const client = { addLabels: vi.fn().mockResolvedValue(undefined) };
    const tools = createGitHubMcpTools({ client: client as never });
    const args = { owner: "o", repo: "r", issueNumber: 3 };

    await tools.callTool({
      name: "add_verified_label",
      arguments: args,
      approval: { approved: true, expectedPayloadHash: approvalPayloadHash("add_verified_label", args) }
    });

    expect(client.addLabels).toHaveBeenCalledWith("o", "r", 3, ["byter:verified"]);
  });

  it("creates a draft fix pull request only with matching approval", async () => {
    const client = {
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "a".repeat(40) } }),
      getCommit: vi.fn().mockResolvedValue({ tree: { sha: "b".repeat(40) } }),
      createTree: vi.fn().mockResolvedValue({ sha: "c".repeat(40) }),
      createCommit: vi.fn().mockResolvedValue({ sha: "d".repeat(40) }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({ number: 9, html_url: "https://github.test/pull/9" })
    };
    const tools = createGitHubMcpTools({ client: client as never });
    const args = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: "byter/fix-9",
      title: "Fix parser crash",
      body: "Verified by Byter.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };

    const result = await tools.callTool({
      name: "create_fix_pull_request",
      arguments: args,
      approval: { approved: true, expectedPayloadHash: approvalPayloadHash("create_fix_pull_request", args) }
    });

    expect(client.getBranch).toHaveBeenCalledWith("o", "r", "main");
    expect(client.getCommit).toHaveBeenCalledWith("o", "r", "a".repeat(40));
    expect(client.createTree).toHaveBeenCalledWith(
      "o",
      "r",
      expect.objectContaining({
        baseTree: "b".repeat(40),
        files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
      })
    );
    expect(client.createCommit).toHaveBeenCalledWith(
      "o",
      "r",
      expect.objectContaining({ tree: "c".repeat(40), parents: ["a".repeat(40)] })
    );
    expect(client.createBranch).toHaveBeenCalledWith("o", "r", "byter/fix-9", "d".repeat(40));
    expect(client.createPullRequest).toHaveBeenCalledWith(
      "o",
      "r",
      expect.objectContaining({ draft: true, head: "byter/fix-9" })
    );
    expect(client.deleteBranch).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("https://github.test/pull/9");
  });

  it("deletes the fix branch when draft pull request creation fails", async () => {
    const client = {
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "a".repeat(40) } }),
      getCommit: vi.fn().mockResolvedValue({ tree: { sha: "b".repeat(40) } }),
      createTree: vi.fn().mockResolvedValue({ sha: "c".repeat(40) }),
      createCommit: vi.fn().mockResolvedValue({ sha: "d".repeat(40) }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockRejectedValue(new Error("pull request failed"))
    };
    const tools = createGitHubMcpTools({ client: client as never });
    const args = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: "byter/fix-9",
      title: "Fix parser crash",
      body: "Verified by Byter.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };

    await expect(
      tools.callTool({
        name: "create_fix_pull_request",
        arguments: args,
        approval: { approved: true, expectedPayloadHash: approvalPayloadHash("create_fix_pull_request", args) }
      })
    ).rejects.toThrow("pull request failed");

    expect(client.deleteBranch).toHaveBeenCalledWith("o", "r", "byter/fix-9");
  });
});
