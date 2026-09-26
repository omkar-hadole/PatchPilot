import { describe, expect, it } from "vitest";
import { parseIssueCommentWebhook, parseIssueWebhook, signWebhookPayload, verifyGitHubWebhook } from "../src/index.js";

describe("GitHub webhook verification", () => {
  it("accepts a matching sha256 signature", () => {
    const payload = JSON.stringify({ action: "opened" });
    const secret = "webhook-secret";

    expect(
      verifyGitHubWebhook({
        payload,
        secret,
        signatureHeader: signWebhookPayload(payload, secret)
      })
    ).toBe(true);
  });

  it("rejects a mismatched signature", () => {
    expect(
      verifyGitHubWebhook({
        payload: "{}",
        secret: "webhook-secret",
        signatureHeader: signWebhookPayload("different", "webhook-secret")
      })
    ).toBe(false);
  });

  it("parses issues webhook payloads", () => {
    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 7,
        title: "Parser crash",
        body: "Trailing escape breaks tokenizer",
        html_url: "https://github.com/MAYANK-MAHAUR/Byter/issues/7"
      },
      repository: {
        name: "Byter",
        full_name: "MAYANK-MAHAUR/Byter",
        default_branch: "main",
        owner: { login: "MAYANK-MAHAUR" }
      }
    });

    const parsed = parseIssueWebhook(payload);

    expect(parsed.issue.number).toBe(7);
    expect(parsed.repository.owner.login).toBe("MAYANK-MAHAUR");
  });

  it("parses issue comment webhook payloads", () => {
    const parsed = parseIssueCommentWebhook(JSON.stringify({
      action: "created",
      issue: {
        number: 7,
        title: "Parser crash",
        body: "Trailing escape breaks tokenizer",
        html_url: "https://github.com/MAYANK-MAHAUR/Byter/issues/7"
      },
      comment: {
        body: "/byter approve run-id abc",
        user: { login: "maintainer" },
        author_association: "OWNER"
      },
      repository: {
        name: "Byter",
        full_name: "MAYANK-MAHAUR/Byter",
        default_branch: "main",
        owner: { login: "MAYANK-MAHAUR" }
      }
    }));

    expect(parsed.action).toBe("created");
    expect(parsed.comment.user?.login).toBe("maintainer");
  });
});
