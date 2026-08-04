import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

afterEach(cleanup);

describe("rendering a markdown file", () => {
  it("renders headings, tables, fenced code and links", () => {
    render(
      <MarkdownPreview
        source={
          "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```yaml\nkind: Service\n```\n\n[docs](https://example.com)\n"
        }
        openExternal={vi.fn()}
      />,
    );

    const preview = screen.getByTestId("markdown-preview");
    expect(preview.querySelector("h1")?.textContent).toBe("Title");
    expect(preview.querySelector("table")).not.toBeNull();
    expect(preview.querySelector("code")?.className).toContain("language-yaml");
    expect(preview.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  // The preview injects HTML, so this is the test that a malicious README
  // cannot reach the webview the app itself runs in.
  it("does not inject script from the source", () => {
    render(
      <MarkdownPreview
        source={'<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n'}
        openExternal={vi.fn()}
      />,
    );

    const preview = screen.getByTestId("markdown-preview");
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.textContent).toContain("<script>");
  });
});

describe("following a link", () => {
  it("opens it in the real browser rather than navigating the app", () => {
    const openExternal = vi.fn();
    render(
      <MarkdownPreview source="[docs](https://example.com)\n" openExternal={openExternal} />,
    );

    const link = screen.getByTestId("markdown-preview").querySelector("a");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link as Element, event);

    expect(openExternal).toHaveBeenCalledWith("https://example.com");
    // Unprevented, the webview would follow the href and replace the app.
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores a click that is not on a link", () => {
    const openExternal = vi.fn();
    render(<MarkdownPreview source="just text\n" openExternal={openExternal} />);

    fireEvent.click(screen.getByTestId("markdown-preview"));

    expect(openExternal).not.toHaveBeenCalled();
  });
});
