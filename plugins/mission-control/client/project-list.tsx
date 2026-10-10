import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Pressable, Text, View, type PanResponderGestureState, type ScrollView } from "react-native";
import { missionPreferences } from "../shared/preferences";
import { AppModal } from "./app-modal";
import { CompactLink } from "./compact-link";
import { DragHandle } from "./host-list";
import { mergeHostOrder, moveVisibleHost } from "./host-order";
import { projectDropTarget } from "./project-order";

type Project = { id: string; name: string };
type Colors = PluginSurfaceProps["theme"]["colors"];
export type ProjectScrollState = { offset: number; height: number; contentHeight: number };
type Drag = { id: string; target: string; delta: number; shift: number; pointer: number; startScroll: number; order: string[]; visible: string[] };

/** Uses the page's actual scroll container on both wide and compact layouts. */
export function ProjectList({ serverId, projects, visibleIds, colors, scrollRef, scrollState, renderProject }: {
  serverId: string; projects: readonly Project[]; visibleIds: readonly string[]; colors: Colors;
  scrollRef: RefObject<ScrollView | null>; scrollState: RefObject<ProjectScrollState>;
  renderProject: (project: Project, handle: ReactNode) => ReactNode;
}) {
  const settings = useSettings(missionPreferences);
  const [pending, setPending] = useState<string[] | null>(null);
  const [dragView, setDragView] = useState<{ id: string; shift: number; target: string } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const writing = useRef(false);
  const tops = useRef(new Map<string, number>());
  const drag = useRef<Drag | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewport = useRef({ top: 0, height: 0 });
  const order = mergeHostOrder(pending ?? (settings.status === "ready" ? settings.values.projectOrder[serverId] ?? [] : []), projects.map(project => project.id));
  const available = new Map(projects.filter(project => visibleIds.includes(project.id)).map(project => [project.id, project]));
  const ordered = order.flatMap(id => available.has(id) ? [available.get(id)!] : []);
  const visible = ordered.map(project => project.id);
  const signature = JSON.stringify(visible);
  const enabled = settings.status === "ready" && !settings.saving && !pending && visible.length > 1;

  function stopDrag() {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    drag.current = null;
    setDragView(null);
  }
  useEffect(() => { stopDrag(); }, [serverId, signature, scrollRef, settings.status === "ready" ? settings.revision : null]);
  useEffect(() => () => { if (timer.current !== null) clearInterval(timer.current); }, []);

  async function saveOrder(next: string[]) {
    if (settings.status !== "ready" || settings.saving || writing.current || JSON.stringify(next) === JSON.stringify(order)) return;
    writing.current = true;
    setPending(next);
    setSaveError(null);
    try {
      const ok = await settings.save({ ...settings.values, projectOrder: { ...settings.values.projectOrder, [serverId]: next } }, settings.revision);
      if (!ok) setSaveError("Project order was not saved. Reload to see the saved order.");
    } catch (error) {
      setSaveError(`Project order was not saved: ${error instanceof Error ? error.message : String(error)}`);
    } finally { writing.current = false; setPending(null); }
  }
  function updateDrag() {
    const current = drag.current;
    if (!current) return;
    current.shift = current.delta + scrollState.current.offset - current.startScroll;
    current.target = projectDropTarget(current.visible, tops.current, current.id, current.shift);
    setDragView({ id: current.id, shift: current.shift, target: current.target });
  }
  function begin(id: string, gesture: PanResponderGestureState) {
    if (!enabled) return;
    stopDrag();
    viewport.current = { top: 0, height: 0 };
    drag.current = { id, target: id, delta: 0, shift: 0, pointer: gesture.y0, startScroll: scrollState.current.offset, order, visible };
    scrollRef.current?.getNativeScrollRef()?.measureInWindow((_x, y, _width, height) => { viewport.current = { top: y, height }; });
    updateDrag();
    timer.current = setInterval(() => {
      const current = drag.current;
      const bounds = viewport.current;
      const state = scrollState.current;
      if (!current || bounds.height <= 0) return;
      const direction = current.pointer < bounds.top + 32 ? -1 : current.pointer > bounds.top + bounds.height - 32 ? 1 : 0;
      if (direction) {
        const next = Math.max(0, Math.min(Math.max(0, state.contentHeight - state.height), state.offset + direction * 12));
        if (next !== state.offset) scrollRef.current?.scrollTo({ y: next, animated: false });
      }
      updateDrag();
    }, 40);
  }
  function move(gesture: PanResponderGestureState) {
    if (!drag.current) return;
    drag.current.delta = gesture.dy;
    drag.current.pointer = gesture.moveY;
    updateDrag();
  }
  function finish() {
    const current = drag.current;
    stopDrag();
    if (current) void saveOrder(moveVisibleHost(current.order, current.visible, current.id, current.target));
  }
  const movingProject = ordered.find(project => project.id === movingId);
  const movingIndex = visible.indexOf(movingId ?? "");
  const error = saveError ?? ((settings.status === "error" || settings.status === "invalid") ? `Project order is unavailable: ${settings.error}` : null);

  return <View style={{ gap: 10 }}>
    {ordered.map(project => {
      const dragging = dragView?.id === project.id;
      const target = dragView && !dragging && dragView.target === project.id;
      const handle = <DragHandle label={`${project.name} project`} colors={colors} disabled={!enabled} horizontal={false}
        begin={gesture => begin(project.id, gesture)} move={move} finish={finish} cancel={stopDrag} open={() => setMovingId(project.id)} />;
      return <View key={project.id} onLayout={event => tops.current.set(project.id, event.nativeEvent.layout.y)}
        style={{ position: "relative", zIndex: dragging ? 10 : 0 }}>
        {target ? <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, height: 3, backgroundColor: colors.accent, borderRadius: 2,
          ...(visible.indexOf(project.id) < visible.indexOf(dragView.id) ? { top: -3 } : { bottom: -3 }) }} /> : null}
        <View style={{ opacity: dragging ? 0.7 : 1, transform: dragging ? [{ translateY: dragView.shift }] : undefined }}>
          {renderProject(project, handle)}
        </View>
      </View>;
    })}
    {settings.status === "loading" ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Loading project order…</Text> : null}
    {pending ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 11 }}>Saving project order…</Text> : null}
    {error ? <View style={{ gap: 4 }}>
      <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text>
      <CompactLink label="Reload project order" colors={colors} onPress={() => { setSaveError(null); void settings.reload(); }} />
    </View> : null}
    <AppModal colors={colors} title={`Reorder ${movingProject?.name ?? "project"}`} open={!!movingProject} onOpenChange={open => { if (!open) setMovingId(null); }}>
      <AppModal.Content>
        <Text style={{ color: colors.foregroundMuted }}>Position {movingIndex + 1} of {visible.length} visible projects. You can also drag the handle beside the project heading.</Text>
        <View style={{ flexDirection: "row", gap: 8, paddingTop: 12 }}>
          {([-1, 1] as const).map(direction => <Pressable key={direction} accessibilityRole="button" accessibilityLabel={`Move ${movingProject?.name} ${direction < 0 ? "earlier" : "later"}`}
            disabled={!enabled || !visible[movingIndex + direction]} onPress={() => { if (movingProject && visible[movingIndex + direction]) void saveOrder(moveVisibleHost(order, visible, movingProject.id, visible[movingIndex + direction])); }}
            style={{ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 7, opacity: enabled && visible[movingIndex + direction] ? 1 : 0.4 }}>
            <Text style={{ color: colors.foreground }}>{direction < 0 ? "Move earlier" : "Move later"}</Text>
          </Pressable>)}
        </View>
      </AppModal.Content>
    </AppModal>
  </View>;
}
