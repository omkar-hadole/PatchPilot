export interface PatchPilotSession {
  id: string;
  title: string | null;
}

export interface PatchPilotTurn {
  id: string;
  sessionId: string;
  status: string;
}

export interface PatchPilotRuntimeEvent {
  sequenceNumber?: number;
  type: string;
  raw: unknown;
}

export type PatchPilotRuntimeEventListener = (event: PatchPilotRuntimeEvent) => void | Promise<void>;

export interface StartPatchPilotSessionInput {
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

export interface StartPatchPilotSessionResult {
  session: PatchPilotSession;
  turn: PatchPilotTurn;
}
