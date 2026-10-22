# Kubernetes: notes for AI agents

This is a plugin for Deck, a Windows app (Tauri, React 19). It is
bundled into one `plugin.js` that Deck imports at run time, inside Deck's own window. Read this
before changing anything.

## Commands

```sh
npm run dev            # build on every save and install into the test Deck, which reloads it
npm run build          # build once into plugin.js
npm run install-local  # build and install into the user's real Deck
npx deck-plugin check  # validate plugin.json
npx deck-plugin publish --dry-run   # everything the registry checks, nothing published
```

The test Deck is a second Deck with its own data, started with
`& "$env:LOCALAPPDATA\Deck\deck.exe" --test` (PowerShell). Develop against it, never the real
Deck: `npm run dev` only ever writes there. Run `npm run install-local` only when the user asks
for the plugin to be installed for real. Its log is `%APPDATA%\Deck-Dev\logs\deck-<date>.log`;
the plugin's `console.warn` and `console.error` lines land there.

## Files

- `plugin.json`: `id` (letters, digits, dashes; it is a folder name and a config key), `name`,
  `description`, `icon` (a lucide icon name), `color`, `version`, `minDeck`, and `permissions`:
  what it uses of Deck (`files`, `processes`, `git`, `network`, `terminals`, `browser`,
  `secrets`, `system`, `deck`; the table is `node_modules/deck-plugin-sdk/permissions.json`). A
  bridge call outside them throws, naming the one to add: add it rather than working around it.
- `src/plugin.tsx`: the entry. Its exports are what Deck uses (below).
- `src/mcp.ts`, if present: tools for Deck's MCP server, built to `mcp.js`.
- `plugin.js` (and `mcp.js`): the build's output, gitignored. Never edit them.
- **The API is `node_modules/deck-plugin-sdk/types/core/bridge.d.ts`**: every function Deck
  exposes, with its documentation, generated from Deck's own source. Read it rather than guessing
  a name. A plugin imports it as `deck-plugin-sdk/bridge`.

## What the plugin can export

`default` (a tab), `PaneView` (a view that can sit in a split pane, given `{ cwd, runInTerminal }`),
`Status` (a footer readout), `Panel` (a footer drawer tab), `commands` (palette entries),
`Settings` (a settings panel), `keybindings`, `Provider` (wraps the app, for state that must
survive the tab closing), `Bar`, and `dispose`. At least one; none is required on its own.

## Rules that are easy to break

- **Import Deck's copies.** `react`, `lucide-react` and the `deck-plugin-sdk/*` modules resolve to
  Deck's own at run time. Never add a second React, or a UI library that bundles one: two
  Reacts in one tree break hooks.
- **No native code.** A plugin can only call what Deck already exposes (`deck-plugin-sdk/bridge`).
  To run a program, use `exec` or `procStream`; to read and write files, the `fs*` calls.
- **Opening files**: `export const opens = [".ext"]` with a `PaneView` makes Deck open those files
  in the plugin, each as its own tab, given as the `file` prop. Open one yourself with `openFile`
  from `deck-plugin-sdk/terminals`; save with `fsWriteBytes`.
- **npm packages are fine** (`npm install` and import): the build bundles them, their images,
  fonts and CSS included, into `plugin.js`. `?raw` on an import gives a file's text (a worker).
  A build step of your own (an esbuild plugin) goes in `deck-plugin.config.mjs` as
  `export const esbuildPlugins = [...]`. Not a package that needs Node (`fs`, `child_process`),
  one that bundles its own React, or one that starts a Web Worker from a file.
- **Storage goes through `configRead` / `configWrite`** with plain names (`"settings"`, or
  `"notes.md"` for a plain file). Deck keeps them in the plugin's own folder. A name never
  written reads as `""`. Do not write a config whose text has not changed: every write wakes
  every config listener in Deck.
- **`listen("config-changed", ...)` gets a `string[]` of names**: act only when it includes one
  of yours.
- **Deck reloads the plugin on every rebuild.** Anything module scope starts (a `setInterval`,
  a `listen`, a window listener) must be stopped in an exported `dispose()`, or the old copy keeps
  running beside the new one. Anything a component creates outside the DOM (an `Audio`, a timer,
  a socket) is stopped in its effect's cleanup.
- **A poll stops when nobody can see it**: skip ticks while `document.hidden`, and do not run it
  while the readout it feeds is switched off.
- **Styling uses Deck's stylesheet.** Tailwind classes Deck does not already use do not exist.
  Use Deck's semantic tokens (`text-text-primary`, `text-text-secondary`, `text-text-muted`,
  `bg-elev`, `border-subtle`, `var(--accent)`) and Deck's components from `deck-plugin-sdk/ui`, so
  the plugin follows the user's theme.
- **No error is dropped silently.** A failed save, load or action logs
  `console.warn("[kube] what failed", e)`.

## More

The full guide (exports, storage, testing, publishing) is in Deck's **Docs** tab, which also has
the API reference for the Deck that is installed.
