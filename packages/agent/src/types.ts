export interface TrueForgeSession {
  id: string;
  title: string | null;
}

export interface TrueForgeTurn {
  id: string;
  sessionId: string;
  status: string;
}

export interface TrueForgeRuntimeEvent {
  sequenceNumber?: number;
  type: string;
  raw: unknown;
}

export type TrueForgeRuntimeEventListener = (event: TrueForgeRuntimeEvent) => void | Promise<void>;

export interface StartByterSessionInput {
  issueUrl: string;
  issueTitle: string;
  issueBody: string;
  repository: string;
  baseBranch: string;
  branchName: string;
  baseSha?: string;
}

export interface ResolveToolApprovalInput {
  sessionId: string;
  previousTurnId: string;
  threadId: string;
  toolCallId: string;
  decision: "allow" | "deny";
  reason?: string;
}

export interface StartByterSessionResult {
  session: TrueForgeSession;
  turn: TrueForgeTurn;
}
