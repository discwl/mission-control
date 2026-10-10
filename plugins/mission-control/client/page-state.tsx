import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction, type RefObject } from "react";
import { ScrollView, type ScrollViewProps } from "react-native";
import { pageMemory } from "./page-memory";

export function usePageState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const subscribe = useCallback((listener: () => void) => pageMemory.subscribe(key, listener), [key]);
  const snapshot = () => pageMemory.read(key, initial);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((next: SetStateAction<T>) => {
    const current = pageMemory.read(key, initial);
    pageMemory.write(key, typeof next === "function" ? (next as (value: T) => T)(current) : next);
  }, [key]);
  return [value, set];
}

type Position = { x: number; y: number };
type PageScrollProps = ScrollViewProps & { memoryKey?: string; scrollRef?: RefObject<ScrollView | null> };
export function PageScrollView({ memoryKey, scrollRef, ...props }: PageScrollProps) {
  return memoryKey ? <RememberedScrollView key={memoryKey} memoryKey={memoryKey} scrollRef={scrollRef} {...props} /> : <ScrollView ref={scrollRef} {...props} />;
}
function RememberedScrollView({ memoryKey, scrollRef, onScroll, onContentSizeChange, onLayout, onScrollBeginDrag, ...props }: PageScrollProps & { memoryKey: string }) {
  const localRef = useRef<ScrollView>(null);
  const ref = scrollRef ?? localRef;
  const saved = useRef(pageMemory.read<Position>(memoryKey, { x: 0, y: 0 }));
  const restoring = useRef(saved.current.x > 0 || saved.current.y > 0);
  const viewport = useRef({ width: 0, height: 0 });
  const content = useRef({ width: 0, height: 0 });
  useLayoutEffect(() => {
    ref.current?.scrollTo({ ...saved.current, animated: false });
  }, [memoryKey]);
  function restore() {
    if (!restoring.current || viewport.current.width <= 0 || viewport.current.height <= 0) return;
    ref.current?.scrollTo({ ...saved.current, animated: false });
    // Wait for async roster/document content before accepting an initial scroll-to-zero.
    if (props.horizontal ? content.current.width + 1 >= saved.current.x + viewport.current.width : content.current.height + 1 >= saved.current.y + viewport.current.height) restoring.current = false;
  }
  return <ScrollView {...props} ref={ref} contentOffset={saved.current} scrollEventThrottle={80}
    onLayout={event => {
      const layout = event.nativeEvent.layout;
      const wasVisible = viewport.current.width > 0 && viewport.current.height > 0;
      viewport.current = layout;
      if (!wasVisible && layout.width > 0 && layout.height > 0) {
        // Paseo can retain both sidebar and surface routes. A hidden route must
        // restore the newest shared position when it becomes visible again.
        saved.current = pageMemory.read(memoryKey, { x: 0, y: 0 });
        restoring.current = saved.current.x > 0 || saved.current.y > 0;
      }
      restore();
      onLayout?.(event);
    }}
    onContentSizeChange={(width, height) => {
      if (width > 0 && height > 0) content.current = { width, height };
      restore();
      onContentSizeChange?.(width, height);
    }}
    onScrollBeginDrag={event => { restoring.current = false; onScrollBeginDrag?.(event); }}
    onScroll={event => {
      const layout = event.nativeEvent.layoutMeasurement;
      const size = event.nativeEvent.contentSize;
      // Some web clients defer layout callbacks. A real scroll event provides
      // current geometry too, so subsequent user scrolling stays writable.
      if (layout.width > 0 && layout.height > 0 && (props.horizontal ? size.width + 1 >= saved.current.x + layout.width : size.height + 1 >= saved.current.y + layout.height)) restoring.current = false;
      if (!restoring.current && layout.width > 0 && layout.height > 0) {
        saved.current = { ...event.nativeEvent.contentOffset };
        pageMemory.write(memoryKey, saved.current);
      }
      onScroll?.(event);
    }} />;
}
