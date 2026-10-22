import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown from the model. Raw HTML stays text (no rehype-raw), and images
 * are dropped: model text can echo output from hosts or tools, so never let
 * it load a remote image (and leak data in the URL) just by being shown.
 */
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>
      {children}
    </ReactMarkdown>
  );
}
