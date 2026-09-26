import type { SecurityFinding, SecurityScanResult } from "./types.js";

interface SecurityRule {
  id: string;
  severity: SecurityFinding["severity"];
  reason: string;
  pattern: RegExp;
}

const rules: SecurityRule[] = [
  {
    id: "credential-exfiltration",
    severity: "critical",
    reason: "Issue text asks the agent to reveal or export credentials.",
    pattern: /\b(print|echo|cat|dump|show|exfiltrate)\b.{0,80}\b(env|secret|token|api[_-]?key|private[_-]?key)\b/i
  },
  {
    id: "dangerous-shell",
    severity: "critical",
    reason: "Issue text contains destructive shell instructions.",
    pattern: /\b(rm\s+-rf\s+\/(?=\s|$)|format\s+[a-z]:(?=\s|$)|del\s+\/[fsq]+(?=\s|$)|Remove-Item\b.{0,40}-Recurse\b)/i
  },
  {
    id: "prompt-injection",
    severity: "high",
    reason: "Issue text attempts to override the agent's system or safety instructions.",
    pattern: /\b(ignore|override|forget)\b.{0,80}\b(system|developer|safety|previous)\b.{0,40}\b(instruction|prompt|rule)s?\b/i
  }
];

export function scanIssueText(text: string): SecurityScanResult {
  const findings = rules.flatMap((rule) => {
    const match = rule.pattern.exec(text);
    if (!match) {
      return [];
    }

    return [
      {
        ruleId: rule.id,
        severity: rule.severity,
        reason: rule.reason,
        matchedText: match[0]
      }
    ];
  });

  return {
    safeToExecute: findings.every((finding) => finding.severity !== "critical"),
    findings
  };
}
