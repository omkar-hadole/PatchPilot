import type { RunStatus } from "@byter/core";
import { apiUrl, type ApprovalActionId } from "./data";

export interface ApprovalSubmission {
  id: string;
  runId: string;
  actionId: ApprovalActionId;
  resultStatus: RunStatus;
  message: string;
  savedAt: string;
  pullRequest?: { number: number; url: string };
}

const storagePrefix = "byter:approval:";

export async function submitApprovalAction(input: {
  runId: string;
  actionId: ApprovalActionId;
  patchHash: string;
}): Promise<ApprovalSubmission> {
  const response = await fetch(apiUrl("/api/approvals"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...approvalAuthHeader()
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(`Approval API returned ${response.status}`);
  }

  const submission = (await response.json()) as ApprovalSubmission;
  window.localStorage.setItem(`${storagePrefix}${input.runId}`, JSON.stringify(submission));
  return submission;
}

function approvalAuthHeader(): Record<string, string> {
  const storedToken = window.localStorage.getItem("byter:approval-token");
  const token = storedToken ?? window.prompt("Approval token") ?? "";
  if (token && !storedToken) {
    window.localStorage.setItem("byter:approval-token", token);
  }

  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function readApprovalSubmission(runId: string): ApprovalSubmission | undefined {
  const raw = window.localStorage.getItem(`${storagePrefix}${runId}`);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as ApprovalSubmission;
  } catch {
    window.localStorage.removeItem(`${storagePrefix}${runId}`);
    return undefined;
  }
}
