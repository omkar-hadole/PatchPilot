import { describe, expect, it } from "vitest";
import { createRun, transitionRun } from "../src/index.js";

const issue = {
  owner: "MAYANK-MAHAUR",
  repo: "Byter",
  issueNumber: 1,
  url: "https://github.com/MAYANK-MAHAUR/Byter/issues/1"
};

describe("Byter state machine", () => {
  it("records a received issue and valid next event", () => {
    const run = createRun("run_1", issue, new Date("2026-08-27T10:00:00.000Z"));
    const next = transitionRun(run, "security-review", "Scanning issue text");

    expect(next.status).toBe("security-review");
    expect(next.events).toHaveLength(2);
    expect(next.events[1]?.message).toBe("Scanning issue text");
  });

  it("rejects unearned green states", () => {
    const run = createRun("run_1", issue);

    expect(() => transitionRun(run, "verified", "Trust me")).toThrow(
      "Invalid Byter transition: received -> verified"
    );
  });

  it("allows runs to enter a terminal failed state from active work", () => {
    const run = transitionRun(createRun("run_1", issue), "security-review", "Scanning issue text");
    const failed = transitionRun(run, "failed", "Runtime crashed before triage completed");

    expect(failed.status).toBe("failed");
    expect(failed.events.at(-1)).toMatchObject({
      status: "failed",
      message: "Runtime crashed before triage completed"
    });
  });

  it("does not leave the terminal failed state", () => {
    const failed = transitionRun(createRun("run_1", issue), "failed", "Unexpected worker failure");

    expect(() => transitionRun(failed, "triaging", "Try again")).toThrow(
      "Invalid Byter transition: failed -> triaging"
    );
  });
});
