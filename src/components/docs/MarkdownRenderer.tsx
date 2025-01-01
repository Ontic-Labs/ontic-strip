import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.min.css";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <article
      className={`prose prose-sm dark:prose-invert max-w-none
        prose-headings:font-mono prose-headings:tracking-tight
        prose-h1:text-xl prose-h1:sm:text-2xl prose-h1:font-bold
        prose-h2:text-base prose-h2:font-semibold prose-h2:border-b prose-h2:pb-1
        prose-h3:text-xs prose-h3:uppercase prose-h3:tracking-wider prose-h3:font-semibold
        prose-table:text-xs
        prose-th:font-mono prose-th:font-semibold prose-th:text-left
        prose-code:text-[11px] prose-code:before:content-none prose-code:after:content-none
        prose-pre:bg-muted/30 prose-pre:border prose-pre:rounded-md
        ${className ?? ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
