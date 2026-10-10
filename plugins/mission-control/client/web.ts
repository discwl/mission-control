/// <reference lib="dom" />

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
