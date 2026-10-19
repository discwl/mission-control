// Paseo switches to its phone layout below its md breakpoint, 720 px wide (the app's unistyles breakpoints). That
// layout shows no Explorer, so a panel opened there stays out of sight, and Paseo 0.12 draws no plugin header buttons
// in it. Mission Control opens its panels as tabs there instead. Measuring the window needs react-native, so the
// app's own layout is in window-layout.ts and this module stays loadable in plain Node tests.

export const compactWidth = 720;

export type Layout = { compact(): boolean; subscribe(listener: () => void): () => void };

/** For callers without a window to measure: every layout counts as wide. */
export const wideLayout: Layout = { compact: () => false, subscribe: () => () => {} };

/** Where a panel that can be either a tab or an Explorer pane should open. */
export function panelLocation(layout: Pick<Layout, "compact">): "explorer" | "workspace" {
  return layout.compact() ? "workspace" : "explorer";
}
