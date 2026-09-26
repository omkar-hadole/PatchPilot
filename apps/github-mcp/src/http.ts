import type { IncomingMessage, ServerResponse } from "node:http";
import {
  approvalPayloadHash,
  createGitHubMcpTools,
  listGitHubTools,
  type GitHubMcpToolName,
  type GitHubMcpToolResult,
  type GitHubMcpWriteToolName,
  type GitHubRestClientLike
} from "./tools.js";

const maxMcpRequestBytes = 2 * 1024 * 1024;
const protocolVersion = "2024-11-05";

export interface GitHubMcpHttpHandlerOptions {
  client: GitHubRestClientLike;
  authToken: string;
  readOnly?: boolean;
}

export function createGitHubMcpHttpHandler(
  options: GitHubMcpHttpHandlerOptions
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const tools = createGitHubMcpTools({ client: options.client });
  const exposedTools = listGitHubTools().filter((tool) => !options.readOnly || !tool.requiresApproval);

  return async (request, response) => {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "MCP endpoint accepts POST only" });
      return;
    }

    if (bearerToken(request) !== options.authToken) {
      sendJson(response, 401, { error: "MCP authentication required" });
      return;
    }

    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = parseJsonRpcRequest(await readRequestBody(request));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid MCP request" });
      return;
    }

    if (rpcRequest.method === "notifications/initialized") {
      response.statusCode = 202;
      response.end();
      return;
    }

    try {
      const result = await dispatchRequest(rpcRequest, tools, exposedTools);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 200, errorResponse(rpcRequest.id, -32602, error instanceof Error ? error.message : "Invalid MCP parameters"));
    }
  };
}

async function dispatchRequest(
  request: JsonRpcRequest,
  tools: ReturnType<typeof createGitHubMcpTools>,
  exposedTools: ReturnType<typeof listGitHubTools>
): Promise<JsonRpcResponse> {
  if (request.method === "initialize") {
    return successResponse(request.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "byter-github", version: "0.1.0" }
    });
  }

  if (request.method === "tools/list") {
    return successResponse(request.id, {
      tools: exposedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchemaFor(tool.name),
        annotations: {
          readOnlyHint: !tool.requiresApproval,
          destructiveHint: tool.name === "create_fix_pull_request"
        }
      }))
    });
  }

  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const name = expectToolName(params.name);
    if (!exposedTools.some((tool) => tool.name === name)) {
      return errorResponse(request.id, -32602, "Tool is not enabled for this MCP connection");
    }
    const args = asRecord(params.arguments);
    let result: GitHubMcpToolResult;

    try {
      // TrueForge enforces requireApprovalForTools on this authenticated MCP server.
      result = await tools.callTool({
        name,
        arguments: args,
        ...(isWriteTool(name)
          ? { approval: { approved: true, expectedPayloadHash: approvalPayloadHash(name, args) } }
          : {})
      });
    } catch (error) {
      return errorResponse(request.id, -32000, error instanceof Error ? error.message : "MCP tool failed");
    }

    return successResponse(request.id, result);
  }

  return errorResponse(request.id, -32601, "MCP method not found");
}

function inputSchemaFor(name: GitHubMcpToolName) {
  switch (name) {
    case "read_issue":
    case "add_verified_label":
      return {
        type: "object",
        required: ["owner", "repo", "issueNumber"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "integer", minimum: 1 }
        }
      };
    case "read_file":
      return {
        type: "object",
        required: ["owner", "repo", "path"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" }
        }
      };
    case "submit_byter_result":
      return {
        type: "object",
        additionalProperties: false,
        required: ["kind", "status", "summary", "proof", "candidatePatch"],
        properties: {
          kind: { type: "string", const: "byter.result" },
          status: {
            type: "string",
            enum: ["patch-ready", "verified", "not-reproduced", "blocked", "failed"]
          },
          summary: { type: "string" },
          proof: {
            type: "object",
            additionalProperties: false,
            required: ["before", "after", "regressions", "attempts"],
            properties: {
              before: { type: "string" },
              after: { type: "string" },
              regressions: { type: "string" },
              attempts: { type: "string" }
            }
          },
          candidatePatch: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["title", "body", "files"],
                properties: {
                  title: { type: "string" },
                  body: { type: "string" },
                  files: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["path", "content"],
                      properties: {
                        path: { type: "string" },
                        content: { type: "string" }
                      }
                    }
                  }
                }
              },
              { type: "null" }
            ]
          }
        }
      };
    case "comment_on_issue":
      return {
        type: "object",
        required: ["owner", "repo", "issueNumber", "body"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "integer", minimum: 1 },
          body: { type: "string" }
        }
      };
    case "create_fix_pull_request":
      return {
        type: "object",
        required: ["owner", "repo", "baseBranch", "branchName", "title", "body", "files"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          baseBranch: { type: "string" },
          branchName: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          files: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              }
            }
          }
        }
      };
  }
}

function isWriteTool(name: GitHubMcpToolName): name is GitHubMcpWriteToolName {
  return name === "add_verified_label" || name === "comment_on_issue" || name === "create_fix_pull_request";
}

function parseJsonRpcRequest(value: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Malformed JSON");
  }

  const request = asRecord(parsed);
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || request.method.length === 0) {
    throw new Error("Expected a JSON-RPC 2.0 request");
  }

  return {
    jsonrpc: "2.0",
    id: request.id as string | number | null | undefined,
    method: request.method,
    params: request.params
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxMcpRequestBytes) {
      throw new Error("MCP request body too large");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function expectToolName(value: unknown): GitHubMcpToolName {
  if (
    value === "read_issue" ||
    value === "read_file" ||
    value === "submit_byter_result" ||
    value === "add_verified_label" ||
    value === "comment_on_issue" ||
    value === "create_fix_pull_request"
  ) {
    return value;
  }

  throw new Error("Unknown MCP tool");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }

  return value as Record<string, unknown>;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (Array.isArray(authorization) || !authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length);
}

function successResponse(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), result };
}

function errorResponse(id: string | number | null | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), error: { code, message } };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}
