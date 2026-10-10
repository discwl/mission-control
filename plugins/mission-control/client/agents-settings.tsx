import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { agentsPanelSettings } from "../shared/agents-panel";

/** Settings → Plugins → Mission Control → Agents panel. onAutoOpenChange applies a saved change at once. */
export function AgentsSettings({ onAutoOpenChange }: PluginSurfaceProps & { onAutoOpenChange: (enabled: boolean) => void }) {
  const settings = useSettings(agentsPanelSettings);
  if (settings.status !== "ready") {
    return <SettingsSection title="Agents panel">
      <SettingsRow label={settings.status === "loading" ? "Loading…" : "Agents panel settings can't be read"} error={settings.status === "loading" ? null : settings.error} />
      {settings.status !== "loading" ? <SettingsAction label="Read the settings again" actionLabel="Reload" onPress={settings.reload} /> : null}
      {settings.status === "invalid" ? <SettingsAction label="Replace the unreadable settings with the defaults" actionLabel="Reset" disabled={settings.saving}
        onPress={async () => { if (await settings.reset()) onAutoOpenChange(false); }} /> : null}
    </SettingsSection>;
  }
  return <SettingsSection title="Agents panel">
    <SettingsSwitch label="Open the Agents panel for each new workspace"
      hint="While this is on, the Agents panel opens once in Explorer for each workspace created after it. Workspaces that already exist aren't opened, and none opens twice."
      value={settings.values.autoOpen} disabled={settings.saving} error={settings.saveError}
      onValueChange={async autoOpen => { if (await settings.save({ ...settings.values, autoOpen }, settings.revision)) onAutoOpenChange(autoOpen); }} />
  </SettingsSection>;
}
