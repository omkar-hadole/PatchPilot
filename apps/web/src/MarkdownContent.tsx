import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export function MarkdownContent({ value, className }: { value: string; className?: string }) {
  return (
    <div className={["markdown-content", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeSanitize, [rehypeKatex, { strict: false, trust: false }]]}
        skipHtml
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
