import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "../src/model-client.js";

describe("parseRetryAfterMs", () => {
  it("reads a numeric Retry-After header as seconds", () => {
    expect(parseRetryAfterMs("2", "")).toBe(2000);
  });

  it("reads an HTTP-date Retry-After header as a delta from now", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const result = parseRetryAfterMs(future, "");
    expect(result).toBeGreaterThan(3000);
    expect(result).toBeLessThan(7000);
  });

  it("falls back to parsing the provider's error message when no header is present", () => {
    const body = JSON.stringify({
      error: { message: "Rate limit reached. Please try again in 18.39s.", code: "rate_limit_exceeded" }
    });
    expect(parseRetryAfterMs(null, body)).toBeCloseTo(18390, -1);
  });

  it("parses a millisecond suggestion from the error message", () => {
    expect(parseRetryAfterMs(null, "Please try again in 500ms")).toBe(500);
  });

  it("returns undefined when nothing can be parsed", () => {
    expect(parseRetryAfterMs(null, "no timing information here")).toBeUndefined();
  });
});
