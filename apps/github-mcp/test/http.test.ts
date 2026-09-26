import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubMcpHttpHandler } from "../src/http.js";
import type { GitHubRestClientLike } from "../src/tools.js";

describe("GitHub MCP HTTP transport", () => {
  let baseUrl: string;
  let server: Server;
  let client: GitHubRestClientLike;

  beforeEach(async () => {
    client = {
      getIssue: vi.fn().mockResolvedValue({
        number: 17,
        title: "Parser crash",
        body: "Trailing escape crashes the parser.",
        html_url: "https://github.test/o/r/issues/17",
        state: "open"
      }),
      addLabels: vi.fn().mockResolvedValue(undefined)
    } as unknown as GitHubRestClientLike;

    const handler = createGitHubMcpHttpHandler({ client, authToken: "mcp-secret" });
    server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = "http://127.0.0.1:" + address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("requires bearer authentication", async () => {
    const response = await fetch(baseUrl + "/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
    });

    expect(response.status).toBe(401);
  });

  it("initializes and advertises the GitHub tools", async () => {
    const initialize = await callMcp("initialize", {}, 1);
    expect(initialize.result.protocolVersion).toBe("2024-11-05");

    const listed = await callMcp("tools/list", {}, 2);
    expect(listed.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "read_issue" }),
        expect.objectContaining({ name: "create_fix_pull_request" })
      ])
    );
  });

  it("returns JSON-RPC invalid-params errors", async () => {
    const result = await callMcp("tools/call", { name: "read_issue" }, 5);

    expect(result.error.code).toBe(-32602);
  });

  it("dispatches read tool calls to the GitHub client", async () => {
    const result = await callMcp(
      "tools/call",
      {
        name: "read_issue",
        arguments: { owner: "o", repo: "r", issueNumber: 17 }
      },
      3
    );

    expect(client.getIssue).toHaveBeenCalledWith("o", "r", 17);
    expect(result.result.content[0].text).toContain("Parser crash");
  });

  it("passes remote writes through the TrueForge approval boundary", async () => {
    const result = await callMcp(
      "tools/call",
      {
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 17 }
      },
      4
    );

    expect(client.addLabels).toHaveBeenCalledWith("o", "r", 17, ["byter:verified"]);
    expect(result.result.content[0].text).toContain("Added byter:verified label.");
  });

  it("can expose a read-only tool surface for autonomous agents", async () => {
    const readOnlyHandler = createGitHubMcpHttpHandler({ client, authToken: "mcp-secret", readOnly: true });
    const readOnlyServer = createServer((request, response) => {
      void readOnlyHandler(request, response);
    });
    await new Promise<void>((resolve) => readOnlyServer.listen(0, "127.0.0.1", resolve));
    const address = readOnlyServer.address() as AddressInfo;
    const readOnlyUrl = "http://127.0.0.1:" + address.port;

    try {
      const listedResponse = await fetch(readOnlyUrl + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mcp-secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" })
      });
      const listed = (await listedResponse.json()) as any;

      expect(listed.result.tools).toEqual([
        expect.objectContaining({
          name: "read_issue",
          annotations: { readOnlyHint: true, destructiveHint: false }
        }),
        expect.objectContaining({
          name: "read_file",
          annotations: { readOnlyHint: true, destructiveHint: false }
        }),
        expect.objectContaining({
          name: "submit_byter_result",
          annotations: { readOnlyHint: true, destructiveHint: false }
        })
      ]);

      const writeResponse = await fetch(readOnlyUrl + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mcp-secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "add_verified_label", arguments: { owner: "o", repo: "r", issueNumber: 17 } }
        })
      });
      const write = (await writeResponse.json()) as any;

      expect(write.error.message).toBe("Tool is not enabled for this MCP connection");
    } finally {
      await new Promise<void>((resolve, reject) => readOnlyServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  async function callMcp(method: string, params: Record<string, unknown>, id: number) {
    const response = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mcp-secret"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });

    expect(response.status).toBe(200);
    return (await response.json()) as any;
  }
});
