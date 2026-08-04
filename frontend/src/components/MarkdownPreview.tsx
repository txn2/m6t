import { useMemo, useRef } from "react";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";
import { linkHrefFrom, renderMarkdown } from "../lib/markdown";

export interface MarkdownPreviewProps {
  readonly source: string;
  /** Injectable for tests and harnesses; defaults to the Wails runtime. */
  readonly openExternal?: (url: string) => void;
}

/**
 * A markdown file rendered for reading (DESIGN.md §5).
 *
 * The HTML is injected rather than built as React elements, which is only
 * safe because of what `lib/markdown.ts` guarantees about it: raw HTML is
 * escaped and link schemes are filtered before it ever gets here. That module
 * is where the argument lives, and it is the one to re-read before changing
 * anything about this injection.
 */
export function MarkdownPreview({
  source,
  openExternal = BrowserOpenURL,
}: MarkdownPreviewProps) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const container = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={container}
      className="markdown"
      data-testid="markdown-preview"
      // A link followed in place would replace the whole application with the
      // target page, in a webview with no back button to return by. Every
      // link goes to the user's real browser instead.
      onClick={(event) => {
        const target = container.current;
        if (target === null) {
          return;
        }
        const href = linkHrefFrom(event.target, target);
        if (href !== null) {
          event.preventDefault();
          openExternal(href);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
