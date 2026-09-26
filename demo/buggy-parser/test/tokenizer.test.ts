import { describe, expect, it } from "vitest";
import { tokenizePattern } from "../src/index.js";

describe("tokenizePattern", () => {
  it("tokenizes literal, wildcard, and escaped characters", () => {
    expect(tokenizePattern("a\\*b*")).toEqual([
      { type: "literal", value: "a" },
      { type: "literal", value: "*" },
      { type: "literal", value: "b" },
      { type: "wildcard", value: "*" }
    ]);
  });

  it("captures the seeded trailing escape bug for the demo issue", () => {
    expect(() => tokenizePattern("\\")).toThrow(/toLowerCase/);
  });
});
