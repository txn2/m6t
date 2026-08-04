import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/**
 * Markdown rendering for the editor's preview mode (DESIGN.md §5).
 *
 * m6t renders whatever markdown a cloned repository happens to contain, into
 * the app's own webview — the same context the Wails bindings live in. That
 * makes the renderer's defaults a security decision, not a formatting one,
 * and it is why micromark is the choice here: it escapes raw HTML unless
 * `allowDangerousHtml` is explicitly set (it is not, and must not be), and it
 * runs every link and image URL through a scheme allowlist, so a
 * `javascript:` href in a README comes out with an empty target rather than
 * as a live script.
 *
 * The GFM extension is what supplies tables, which the issue's acceptance
 * criteria call for alongside headings, fenced code and links.
 */

/**
 * Renders markdown to HTML that is safe to inject.
 *
 * The output is trusted only because of what is NOT enabled above. Anything
 * that turns raw HTML back on — `allowDangerousHtml`, a custom html
 * extension, a different renderer — invalidates that and would need a
 * sanitizer in front of the injection site instead.
 */
export function renderMarkdown(source: string): string {
  return micromark(source, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
}

/**
 * The href of the anchor an event landed on, or null when the click was not
 * on a link.
 *
 * The preview's links must not navigate: this is a webview showing the whole
 * application, so following an external href in place would replace m6t with
 * the target page and there is no back button to return with. The pane hands
 * what this finds to the runtime's external-browser call instead.
 *
 * The walk up from the event target is what makes a click on a link's inner
 * `<code>` or `<strong>` behave like a click on the link.
 */
export function linkHrefFrom(target: EventTarget | null, within: Element): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const anchor = target.closest("a");
  if (anchor === null || !within.contains(anchor)) {
    return null;
  }
  const href = anchor.getAttribute("href");
  return href === null || href === "" ? null : href;
}
