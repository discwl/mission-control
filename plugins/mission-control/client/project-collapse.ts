import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { missionPreferences } from "../shared/preferences";
import { applyCollapseChanges, sameKeys, type CollapseChange } from "./project-summary";

/**
 * Collapsed project blocks, saved in the installation host's layout settings.
 * Changes are kept as operations and replayed onto the stored list, so a change
 * made before settings load never replaces entries it did not touch.
 * One save runs at a time against the latest revision.
 */
export function useCollapsedProjects() {
  const settings = useSettings(missionPreferences);
  const [changes, setChanges] = useState<CollapseChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const attempted = useRef<string | null>(null);
  const ready = settings.status === "ready";
  const collapsed = applyCollapseChanges(ready ? settings.values.collapsedProjects : [], changes);
  const revision = ready ? settings.revision : null;

  useEffect(() => {
    if (settings.status !== "ready" || settings.saving || changes.length === 0) return;
    const stored = settings.values.collapsedProjects;
    const target = applyCollapseChanges(stored, changes);
    const lastId = changes[changes.length - 1].id;
    const settle = () => setChanges(current => current.filter(change => change.id > lastId));
    if (sameKeys(target, stored)) { settle(); return; }
    if (attempted.current === settings.revision) return;
    attempted.current = settings.revision;
    void settings.save({ ...settings.values, collapsedProjects: target }, settings.revision).then(ok => {
      if (ok) { setError(null); settle(); return; }
      // Roll back to the stored state rather than retrying a conflicting write.
      attempted.current = null;
      setChanges([]);
      setError("Collapsed projects were not saved. Reload to see the saved layout.");
    });
  }, [changes, revision, settings.saving, settings.status]);

  function update(keys: readonly string[], collapse: boolean) {
    const id = nextId.current++;
    setChanges(current => [...current, { id, keys: [...keys], collapse }]);
  }

  return {
    isCollapsed: (key: string) => collapsed.includes(key),
    toggle: (key: string) => update([key], !collapsed.includes(key)),
    setAll: update,
    error: error ?? (settings.status === "error" || settings.status === "invalid" ? `Collapsed projects can't be saved right now: ${settings.error}. Changes apply to this session and are saved after the layout reloads.` : null),
    reload: () => { setError(null); void settings.reload(); },
  };
}
