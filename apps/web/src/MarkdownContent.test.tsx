import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { truncateAtBoundary } from "./data.js";
import { MarkdownContent } from "./MarkdownContent.js";

describe("MarkdownContent", () => {
  it("renders GitHub-style math while stripping raw HTML", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent value={"Inline $E = mc^2$.\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n<script>alert('no')</script>"} />
    );

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).toContain("E = mc^2");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
  });

  it("shortens summaries without cutting the final word", () => {
    expect(truncateAtBoundary("A complete explanation with another important detail", 34)).toBe("A complete explanation with...");
  });
});
