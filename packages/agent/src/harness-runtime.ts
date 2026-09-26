import { randomUUID } from "node:crypto";
import {
  approvalPayloadHash,
  createGitHubMcpTools,
  type GitHubMcpToolName,
  type GitHubMcpWriteToolName,
  type GitHubRestClientLike
} from "@byter/github-mcp";
import { ModelHttpError, type ModelClientLike, type ModelMessage, type ModelToolSchema } from "./model-client.js";
import { LocalSandboxProvider, type SandboxProvider, type SandboxWorkspace } from "./sandbox.js";
import { buildInitialUserMessage, buildProofContractRecoveryMessage, buildHarnessSystemPrompt } from "./byter-agent.js";
import type {
  ResolveToolApprovalInput,
  StartByterSessionInput,
  StartByterSessionResult,
  TrueForgeRuntimeEvent,
  TrueForgeRuntimeEventListener,
  TrueForgeTurn
} from "./types.js";

const gatedTools = new Set<GitHubMcpWriteToolName>(["add_verified_label", "comment_on_issue", "create_fix_pull_request"]);
const maxIterationsDefault = 40;

interface PendingApprovalState {
  turnId: string;
  threadId: string;
  toolCallId: string;
  sourceEventId: string;
  toolName: GitHubMcpWriteToolName;
  arguments: Record<string, unknown>;
  payloadHash: string;
}

interface SessionRecord {
  id: string;
  title: string | null;
  messages: ModelMessage[];
  sandbox?: SandboxWorkspace;
  eventsByTurn: Map<string, TrueForgeRuntimeEvent[]>;
  allEvents: TrueForgeRuntimeEvent[];
  pendingApproval?: PendingApprovalState;
}

export interface HarnessRuntimeConfig {
  githubClient: GitHubRestClientLike;
  model: ModelClientLike;
  sandboxProvider?: SandboxProvider;
  maxIterations?: number;
}

/**
 * Byter's own coding-agent harness: calls the configured model directly,
 * executes GitHub MCP tools and sandbox commands in-process, and pauses on
 * gated writes for maintainer approval. Implements the same session/turn
 * surface the server previously drove through TrueForge, so apps/server
 * needs no changes beyond how this runtime is constructed.
 */
export class PatchPilotHarnessRuntime {
  private readonly githubTools: ReturnType<typeof createGitHubMcpTools>;
  private readonly model: ModelClientLike;
  private readonly sandboxProvider: SandboxProvider;
  private readonly maxIterations: number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(config: HarnessRuntimeConfig) {
    this.githubTools = createGitHubMcpTools({ client: config.githubClient });
    this.model = config.model;
    this.sandboxProvider = config.sandboxProvider ?? new LocalSandboxProvider();
    this.maxIterations = config.maxIterations ?? maxIterationsDefault;
  }

  async startSession(input: StartByterSessionInput): Promise<StartByterSessionResult> {
    const sessionId = `session_${randomUUID()}`;
    const session: SessionRecord = {
      id: sessionId,
      title: input.issueTitle,
      messages: [
        { role: "system", content: buildHarnessSystemPrompt() },
        { role: "user", content: buildInitialUserMessage(input) }
      ],
      eventsByTurn: new Map(),
      allEvents: []
    };
    this.sessions.set(sessionId, session);

    const turnId = `turn_${randomUUID()}`;
    await this.runLoop(session, turnId);

    return {
      session: { id: sessionId, title: session.title },
      turn: { id: turnId, sessionId, status: "running" }
    };
  }

  async listSessionEvents(sessionId: string): Promise<TrueForgeRuntimeEvent[]> {
    return this.requireSession(sessionId).allEvents;
  }

  async subscribeToTurn(
    sessionId: string,
    turnId: string,
    onEvent?: TrueForgeRuntimeEventListener
  ): Promise<TrueForgeRuntimeEvent[]> {
    const session = this.requireSession(sessionId);
    const events = session.eventsByTurn.get(turnId) ?? [];
    for (const event of events) {
      await onEvent?.(event);
    }
    return events;
  }

  async resolveToolApproval(input: ResolveToolApprovalInput): Promise<TrueForgeTurn> {
    const session = this.requireSession(input.sessionId);
    const pending = session.pendingApproval;
    if (!pending || pending.toolCallId !== input.toolCallId) {
      throw new Error("No matching pending approval for this session");
    }
    session.pendingApproval = undefined;

    const newTurnId = `turn_${randomUUID()}`;

    if (input.decision === "deny") {
      const resultText = JSON.stringify({ error: input.reason ?? "Maintainer denied this write" });
      this.recordToolResponseEvent(session, newTurnId, resultText, false);
      session.messages.push({ role: "tool", toolCallId: pending.toolCallId, content: resultText });
      this.recordDoneEvent(session, newTurnId);
      await session.sandbox?.cleanup();
      return { id: newTurnId, sessionId: session.id, status: "completed" };
    }

    let resultText: string;
    try {
      const toolResult = await this.githubTools.callTool({
        name: pending.toolName,
        arguments: pending.arguments,
        approval: { approved: true, expectedPayloadHash: pending.payloadHash }
      });
      resultText = toolResult.content.map((part) => part.text).join("\n");
      this.recordToolResponseEvent(session, newTurnId, JSON.stringify({ result: resultText }), false);
    } catch (error) {
      resultText = JSON.stringify({ error: error instanceof Error ? error.message : "Approved tool call failed" });
      this.recordToolResponseEvent(session, newTurnId, resultText, false);
    }
    session.messages.push({ role: "tool", toolCallId: pending.toolCallId, content: resultText });

    await this.runLoop(session, newTurnId);
    return { id: newTurnId, sessionId: session.id, status: "running" };
  }

  async requestProofContract(sessionId: string): Promise<TrueForgeTurn> {
    const session = this.requireSession(sessionId);
    session.messages.push({ role: "user", content: buildProofContractRecoveryMessage() });
    const turnId = `turn_${randomUUID()}`;
    await this.runLoop(session, turnId);
    return { id: turnId, sessionId, status: "running" };
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown PatchPilot session: ${sessionId}`);
    return session;
  }

  private async runLoop(session: SessionRecord, turnId: string): Promise<void> {
    const maxMalformedGenerationRetries = 3;
    let malformedGenerationRetries = 0;

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      let response;
      try {
        response = await this.model.chat(session.messages, toolSchemas());
      } catch (error) {
        if (isMalformedGenerationError(error) && malformedGenerationRetries < maxMalformedGenerationRetries) {
          malformedGenerationRetries += 1;
          this.recordEvent(session, turnId, {
            type: "agent.recovery",
            raw: {
              type: "agent.recovery",
              id: randomUUID(),
              created_at: new Date().toISOString(),
              content: `Model generated a tool call the provider could not parse (attempt ${malformedGenerationRetries}/${maxMalformedGenerationRetries}); asking it to retry with valid, unencoded arguments.`
            }
          });
          session.messages.push({
            role: "user",
            content:
              "Your last tool call could not be parsed as valid JSON, most likely because it contained a large base64-encoded blob or another oversized encoded string in a single argument. Do not encode file contents. Retry the same step using a heredoc with plain literal text, split across multiple smaller run_command calls if the content is large."
          });
          continue;
        }

        this.recordDoneEvent(session, turnId, error instanceof Error ? error.message : "Model call failed");
        await session.sandbox?.cleanup();
        return;
      }

      const modelEventId = randomUUID();
      this.recordEvent(session, turnId, {
        type: "model.message",
        raw: {
          type: "model.message",
          id: modelEventId,
          created_at: new Date().toISOString(),
          content: response.content ?? "",
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
        }
      });
      session.messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });

      if (response.toolCalls.length === 0) {
        this.recordDoneEvent(session, turnId);
        await session.sandbox?.cleanup();
        return;
      }

      for (const call of response.toolCalls) {
        if (gatedTools.has(call.name as GitHubMcpWriteToolName)) {
          const toolName = call.name as GitHubMcpWriteToolName;
          let payloadHash: string;
          try {
            payloadHash = approvalPayloadHash(toolName, call.arguments);
          } catch (error) {
            const errorText = JSON.stringify({
              error: error instanceof Error ? error.message : `Invalid arguments for ${toolName}`
            });
            this.recordToolResponseEvent(session, turnId, errorText, false);
            session.messages.push({ role: "tool", toolCallId: call.id, content: errorText });
            continue;
          }

          session.pendingApproval = {
            turnId,
            threadId: "main",
            toolCallId: call.id,
            sourceEventId: modelEventId,
            toolName,
            arguments: call.arguments,
            payloadHash
          };
          this.recordEvent(session, turnId, {
            type: "tool.approval_required",
            raw: {
              type: "tool.approval_required",
              id: randomUUID(),
              created_at: new Date().toISOString(),
              threadId: "main",
              toolCalls: [{ id: call.id, toolCallId: call.id, sourceEventId: modelEventId }]
            }
          });
          return;
        }

        const isSandboxTool = call.name === "run_command";
        let resultText: string;
        try {
          if (isSandboxTool) {
            const sandbox = await this.ensureSandbox(session, turnId);
            const command = String(call.arguments.command ?? "");
            const timeoutMs = typeof call.arguments.timeoutMs === "number" ? call.arguments.timeoutMs : undefined;
            const execution = await sandbox.exec(command, timeoutMs);
            resultText = JSON.stringify({
              exitCode: execution.exitCode,
              stdout: execution.stdout,
              stderr: execution.stderr,
              timedOut: execution.timedOut
            });
          } else {
            const toolResult = await this.githubTools.callTool({
              name: call.name as GitHubMcpToolName,
              arguments: call.arguments
            });
            resultText = JSON.stringify({ result: toolResult.content.map((part) => part.text).join("\n") });
          }
        } catch (error) {
          resultText = JSON.stringify({ error: error instanceof Error ? error.message : "Tool call failed" });
        }

        this.recordToolResponseEvent(session, turnId, resultText, isSandboxTool);
        session.messages.push({ role: "tool", toolCallId: call.id, content: resultText });
      }
    }

    this.recordDoneEvent(session, turnId, "Byter agent exhausted its token budget before completing this turn");
    await session.sandbox?.cleanup();
  }

  private async ensureSandbox(session: SessionRecord, turnId: string): Promise<SandboxWorkspace> {
    if (!session.sandbox) {
      session.sandbox = await this.sandboxProvider.createWorkspace(session.id);
      this.recordEvent(session, turnId, {
        type: "sandbox.created",
        raw: {
          type: "sandbox.created",
          id: randomUUID(),
          created_at: new Date().toISOString(),
          sandbox_id: session.sandbox.id
        }
      });
    }
    return session.sandbox;
  }

  private recordToolResponseEvent(session: SessionRecord, turnId: string, content: string, _sandbox: boolean): void {
    this.recordEvent(session, turnId, {
      type: "tool.response",
      raw: {
        type: "tool.response",
        id: randomUUID(),
        created_at: new Date().toISOString(),
        content
      }
    });
  }

  private recordDoneEvent(session: SessionRecord, turnId: string, errorMessage?: string): void {
    this.recordEvent(session, turnId, {
      type: "turn.done",
      raw: {
        type: "turn.done",
        id: randomUUID(),
        created_at: new Date().toISOString(),
        ...(errorMessage ? { state: { status: "error", message: errorMessage } } : { state: { status: "completed" } })
      }
    });
  }

  private recordEvent(session: SessionRecord, turnId: string, event: TrueForgeRuntimeEvent): void {
    const sequenced: TrueForgeRuntimeEvent = { ...event, sequenceNumber: session.allEvents.length };
    session.allEvents.push(sequenced);
    const turnEvents = session.eventsByTurn.get(turnId) ?? [];
    turnEvents.push(sequenced);
    session.eventsByTurn.set(turnId, turnEvents);
  }
}

function isMalformedGenerationError(error: unknown): boolean {
  if (!(error instanceof ModelHttpError)) return false;
  if (error.status !== 400) return false;
  return /tool[_ ]?(use|call)[_ ]?(failed|invalid)|failed to parse tool call/i.test(error.message);
}

function toolSchemas(): ModelToolSchema[] {
  return [
    {
      name: "read_issue",
      description: "Read a GitHub issue by owner, repo, and number.",
      parameters: {
        type: "object",
        required: ["owner", "repo", "issueNumber"],
        properties: { owner: { type: "string" }, repo: { type: "string" }, issueNumber: { type: "integer" } }
      }
    },
    {
      name: "read_file",
      description: "Read a repository file at an optional ref.",
      parameters: {
        type: "object",
        required: ["owner", "repo", "path"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" }
        }
      }
    },
    {
      name: "run_command",
      description: "Execute a shell command in the reproduction sandbox workspace and observe stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string" }, timeoutMs: { type: "integer" } }
      }
    },
    {
      name: "submit_byter_result",
      description: "Submit the final Byter proof contract without mutating GitHub.",
      parameters: {
        type: "object",
        required: ["kind", "status", "summary", "proof", "candidatePatch"],
        properties: {
          kind: { type: "string", const: "byter.result" },
          status: { type: "string", enum: ["patch-ready", "verified", "not-reproduced", "blocked", "failed"] },
          summary: { type: "string" },
          proof: {
            type: "object",
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
                required: ["title", "body", "files"],
                properties: {
                  title: { type: "string" },
                  body: { type: "string" },
                  files: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["path", "content"],
                      properties: { path: { type: "string" }, content: { type: "string" } }
                    }
                  }
                }
              },
              { type: "null" }
            ]
          }
        }
      }
    },
    {
      name: "comment_on_issue",
      description: "Post a Byter evidence comment. Requires maintainer approval.",
      parameters: {
        type: "object",
        required: ["owner", "repo", "issueNumber", "body"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "integer" },
          body: { type: "string" }
        }
      }
    },
    {
      name: "create_fix_pull_request",
      description: "Create a fix branch with explicit file contents and open a draft pull request. Requires maintainer approval.",
      parameters: {
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
            items: {
              type: "object",
              required: ["path", "content"],
              properties: { path: { type: "string" }, content: { type: "string" } }
            }
          }
        }
      }
    }
  ];
}
