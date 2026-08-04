import { describe, expect, it } from "vitest";
import { linkHrefFrom, renderMarkdown } from "./markdown";

// The issue's third acceptance criterion, one case each.
describe("what the preview has to render", () => {
  it("renders headings", () => {
    expect(renderMarkdown("# Title\n")).toContain("<h1>Title</h1>");
  });

  it("renders tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n");

    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders fenced code with its language", () => {
    const html = renderMarkdown("```yaml\nkind: Deployment\n```\n");

    expect(html).toContain('<code class="language-yaml">');
    expect(html).toContain("kind: Deployment");
  });

  it("renders links", () => {
    expect(renderMarkdown("[docs](https://example.com)\n")).toContain(
      '<a href="https://example.com">docs</a>',
    );
  });
});

// A cloned repository's README is untrusted input rendered into the webview
// that hosts the application and its Wails bindings. These are the tests that
// fail if someone turns raw HTML back on.
describe("untrusted markdown", () => {
  it("escapes a script tag rather than executing it", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an inline event handler", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n');

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("strips a javascript: URL from a link", () => {
    expect(renderMarkdown("[click](javascript:alert(1))\n")).not.toContain("javascript:");
  });

  it("strips a javascript: URL from an image", () => {
    expect(renderMarkdown("![x](javascript:alert(1))\n")).not.toContain("javascript:");
  });

  it("leaves an ordinary https link intact", () => {
    expect(renderMarkdown("[ok](https://example.com/a?b=1)\n")).toContain(
      'href="https://example.com/a?b=1"',
    );
  });
});

describe("finding the link behind a click", () => {
  /** Builds a detached preview container holding `html`. */
  const container = (html: string): Element => {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  };

  it("finds the href of a clicked link", () => {
    const el = container('<p><a href="https://example.com">docs</a></p>');

    expect(linkHrefFrom(el.querySelector("a"), el)).toBe("https://example.com");
  });

  // Clicking the `<code>` inside a link is still clicking the link.
  it("finds the href from a node nested inside the link", () => {
    const el = container('<p><a href="https://example.com"><code>docs</code></a></p>');

    expect(linkHrefFrom(el.querySelector("code"), el)).toBe("https://example.com");
  });

  it("ignores a click that is not on a link", () => {
    const el = container("<p>just text</p>");

    expect(linkHrefFrom(el.querySelector("p"), el)).toBeNull();
  });

  it("ignores a link with an empty href, which is what a stripped URL leaves", () => {
    const el = container('<p><a href="">click</a></p>');

    expect(linkHrefFrom(el.querySelector("a"), el)).toBeNull();
  });

  it("ignores an anchor outside the preview", () => {
    const outside = container('<a href="https://elsewhere.test">x</a>');
    const preview = container("<p>nothing here</p>");

    expect(linkHrefFrom(outside.querySelector("a"), preview)).toBeNull();
  });

  it("ignores a non-element event target", () => {
    expect(linkHrefFrom(null, container("<p>x</p>"))).toBeNull();
  });
});
