/**
 * The browser APIs jsdom does not implement and Radix expects.
 *
 * Radix positions its menus with Floating UI and manages focus and pointer
 * capture on the way in and out. jsdom implements none of that, and without
 * these a menu test fails inside the library rather than on an assertion —
 * which says nothing about the component under test.
 *
 * They are the smallest shims that let the real component run: no behaviour is
 * faked, only the measurements a headless DOM has no way to produce.
 */

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {
      // Nothing to report: jsdom lays nothing out, so no box ever changes.
    }
    unobserve() {
      // As above.
    }
    disconnect() {
      // As above.
    }
  };
}

if (!("DOMRect" in globalThis)) {
  globalThis.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    get top() {
      return this.y;
    }
    get left() {
      return this.x;
    }
    get right() {
      return this.x + this.width;
    }
    get bottom() {
      return this.y + this.height;
    }
    static fromRect(rect?: DOMRectInit) {
      return new DOMRect(rect?.x, rect?.y, rect?.width, rect?.height);
    }
    toJSON() {
      return { ...this };
    }
  } as unknown as typeof DOMRect;
}

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;
