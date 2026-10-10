# Mission Control navigation

Implemented 2026-09-23. The plugin return-state change is loaded on personal.

Switching Paseo's sidebar to the right host needs a Paseo change. The installed release (0.9.2) ignores the `focusHost` option that Mission Control passes on every Open agent and Open workspace, and plugins have no other way to set the host filter (checked 26 Sep 2026; see the task 3 report in the vault). The patch is at `C:\Code\paseo-navigation\mission-control-navigation.patch`; proposing it upstream is the user's decision.

## Return to your place

Click Mission Control in Paseo's sidebar to return to the last view in this client session. The plugin remembers the selected host/workspace, Workspaces/Attention/Tasks/Docs tab, searches and filters, task List/Board choice, selected task, and Docs file and expanded folders. Scroll positions are keyed to each view. State lives in the plugin's client runtime, so reloading the plugin or restarting the client resets it. It is not written to host-wide settings or shared with other devices.

Paseo Search / Command Center also includes **Back to Mission Control**. The plugin registers `/mission-control` as a workspace composer shortcut; its submission still needs a normal interactive-client check. The command opens the existing surface without messaging an agent. Existing unsaved note draft and save protections remain in place.

Paseo may retain both a sidebar route and a surface route. They subscribe to the same page state. Scroll containers ignore zero-size hidden views, and synchronize from the latest remembered position when shown again.

## Match Paseo's host filter to the destination

Mission Control passes `focusHost: true` on every `navigation.openAgent` and `navigation.openWorkspace` action, including Attention and agent-parent links. The Paseo API addition is opt-in for other plugins:

```ts
navigation.openAgent({ serverId, agentId, focusHost: true });
navigation.openWorkspace({ serverId, workspaceId, focusHost: true });
```

In the updated client, that selects only the destination host and clears project and label filters that could hide the destination. Sidebar grouping is preserved. Repeated navigation to the same host does not toggle it off. Existing calls without the option retain their previous behavior. Synchronously rejected navigation does not change the filter. The API advertises `navigation.supportsFocusHost === true` for clients that implement the option; older clients ignore it and still navigate normally.

The SDK contract, navigation owner, and sidebar store change are in the shared Paseo app, so the same source behavior applies to desktop, web, and mobile. Each client must receive a build containing the change; a plugin reload alone cannot update it.

## Paseo source and Windows build

A separate official checkout was created at `C:\Code\paseo-navigation`, based on getpaseo/paseo commit `fbc83613c0ceffc6658bd1a5a9c52c9d335c6f48` (0.9.1). The earlier helper-only sparse clone was not suitable for building the client.

- Source patch: `C:\Code\paseo-navigation\mission-control-navigation.patch` (six source/test/documentation files).
- Windows unpacked build: `C:\Code\paseo-navigation\packages\desktop\release\win-unpacked\Paseo.exe`.
- Keep the whole `win-unpacked` directory together; the executable needs its resources.
- This is a local development build. It has not replaced the installed Paseo application, been published upstream, or been tested against a remote host.
- Do not launch it over a running instance expecting the existing app to acquire the change. Client activation needs a coordinated app switch; do not stop the main daemon while agents are working.

Build preparation used `npm ci --ignore-scripts --no-audit --no-fund`, `npm run postinstall`, and `npm run build:app-deps`. The desktop script completed the app export, server dependencies, and desktop main compilation. npm's Windows argument forwarding then passed a bare `never` to electron-builder; packaging was completed explicitly with:

```powershell
# From C:\Code\paseo-navigation\packages\desktop
node ../../node_modules/electron-builder/cli.js --config electron-builder.yml --win --x64 --dir --publish never
```

## Verification

- Mission Control TypeScript check passed.
- `node --experimental-strip-types --test client/page-memory.test.mjs`: four tests passed (navigation lifetime, host/workspace isolation, falsy values, separate clients).
- Paseo plugin SDK build and app typecheck passed.
- Paseo's focused navigation/sidebar tests: 31 tests passed across three files, including the existing hook suite. The new tests use the real sidebar store for host/project/label filter assertions.
- Paseo lint on the five changed TypeScript files passed; formatting and `git diff --check` passed.
- Windows app export, desktop main build, and unpacked packaging passed.
- In the connected personal browser: opened an agent, returned with Attention search retained; opened a workspace and returned with selection and Board view retained; returned with the same Docs file and expanded folder; Command Center's Back to Mission Control opened the remembered surface. The selected document was retained at 390px width with no page-width overflow. After fixing mount restoration and measuring only the scroll axis, two consecutive open-workspace/return trips restored inspector offsets of 240px and 420px; scrolling again after the first return updated the remembered position.
- Browser screenshot capture intermittently reported that the tab had not painted, so later checks used visible rendered DOM and controls. Physical mobile, the new packaged desktop runtime, remote-host and many-host navigation, and composer shortcut submission remain unverified.
- Gortex diff detection cannot see this repo's untracked files on its unborn branch. Explicit symbol impact/guard/contract checks were used; a pre-existing large-component warning remains. No Git commit or push was made.
