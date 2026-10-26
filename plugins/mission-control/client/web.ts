/// <reference lib="dom" />

// React portal events still bubble through the icon's composer button. Stop them in
// the bubble phase, after inputs and actions handle them, without preventing focus.
export function isolateModalEvents() {
  if (typeof window === "undefined") return {};
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return { onClick: stop, onKeyDown: stop, onKeyUp: stop };
}

// Bind a DOM context menu only when a React Native web ref is a DOM element.
export function bindReviewContextMenu(node: unknown, open: () => void): () => void {
  if (typeof window === "undefined" || !node || typeof (node as Element).addEventListener !== "function") return () => {};
  const element = node as Element;
  const listener = (event: Event) => { event.preventDefault(); event.stopPropagation(); open(); };
  element.addEventListener("contextmenu", listener);
  return () => element.removeEventListener("contextmenu", listener);
}

// Paseo 0.9.1 does not expose a sidebar toggle to plugin surfaces.
// Forward its documented layout shortcut from a web-only button.
export function togglePaseoSidebar(): void {
  if (typeof window === "undefined") return;
  const isMac = /Mac/i.test(navigator.platform);
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key: ".",
    code: "Period",
    ctrlKey: !isMac,
    metaKey: isMac,
    bubbles: true,
    cancelable: true,
  }));
}
