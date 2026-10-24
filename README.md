# OpenCode Projects Studio

A desktop studio for **opencode** projects, built as an **Electron** app on top of
the [opencode-web-chat](https://github.com/mondalaci/opencode-web-chat) UI
(Vue 3, Vite, TypeScript, Reka UI).

> Not built by the OpenCode team and not affiliated with them in any way. The
> name follows OpenCode's own convention for projects that build on it
> (`opencode-*`); the app is an independent client for the opencode server.

It keeps the whole chat experience — streaming Markdown, reasoning blocks, tool
calls, permissions and questions — and reorganises it around projects instead of
conversations:

- **Projects sidebar** — every project the server knows about, each showing one
  conversation: its newest. The list is ordered by most recent activity, and the
  newest conversation of the busiest project is what opens on launch. The
  chevron on a project row expands it to list that project's conversations
  (newest first); `Alt`+`L` toggles the current project's row. The header's
  archive button opens the archived conversations page, grouped by project.
  Clicking one opens it in the conversation pane, read-only, so it can be
  reviewed before being restored or permanently deleted.
- **Diff panel** — a permanent right-hand panel listing the uncommitted changes of
  the active project's repository as a flat list of file paths, with the count
  beside the title and the staged ones under their own heading. It re-scans the
  working tree on a timer, so there is nothing to refresh by hand; the file names
  keep their two-tone scheme (a dimmer directory leading to a bright file name)
  and the status lives in the letter beside them.
- **Diffs** — clicking a file in that panel opens it in the editor area: the
  whole file on both sides, split or unified, with line numbers, syntax
  highlighting, `+n −m` statistics, a change map down the right edge and change
  bars in the gutter. Clicking an image in a conversation enlarges it to the
  window, and clicking again returns it.
- **Conversation state dots** — every project row carries a dot for its newest
  conversation: red blocked, amber working, green done and not yet opened, grey
  idle.
- **Tray icon** — the same state rolled up across all projects into one badge,
  with a menu that jumps straight to the conversation that needs you.

Chat and diffs share the centre pane: opening a diff replaces the conversation
until you go back (the `←` button or `Esc`).

## Screenshots

Projects sidebar, chat, and the source-control panel for the active project:

![Studio](docs/screenshots/studio.png)

Clicking a changed file opens its diff in the centre pane:

![Diff](docs/screenshots/diff.png)

## Getting started

```bash
npm install
```

Development, with the Vite dev server and Electron launched together (hot reload
in the renderer):

```bash
npm run app:dev
```

Production build, then run the packaged-style app from `dist/`:

```bash
npm run build
npm run app
```

`npm run app:build` does both in one step.

An opencode server must be running for the app to connect:

```bash
opencode serve --service --port 4097
```

The app targets the opencode **v2** HTTP API (`/api/*`). That server always
requires HTTP Basic authentication; the password lives in the server's
`service.json` (its default username is `opencode`). On first launch the app scans
local ports and shows the instance picker — `4097` first, then the legacy
`4096` — asking for the password. After that the last server is restored
automatically.

Other scripts: `npm run dev` (Vite only, for UI work in a browser),
`npm run typecheck`, `npm run preview`.

## Configuration

An optional runtime config is fetched from the app root as
`/opencode-projects-studio.json`. The real file is gitignored; copy the committed
template to create one:

```bash
cp public/opencode-projects-studio.example.json public/opencode-projects-studio.json
```

```json
{
  "defaultAgent": "plan"
}
```

`defaultAgent` preselects a primary agent on load, as long as the server exposes
it; a `?agent=` GET param still takes precedence.

Conversation search (`Alt`+`F`) uses the shared
[**opencode-search**](https://github.com/mondalaci/opencode-search) service (a
small Bun FTS5/BM25 index over message text, listening on `127.0.0.1:27184`)
when it is running, and falls back to the server's own title search when it is
not. The sidebar header shows which one answered ("Content search" or
"Fallback · titles"). Results are scoped to the current project's directory,
matching the sidebar.

The service lives in its own repository,
[`opencode-search`](https://github.com/mondalaci/opencode-search), and is shared
with [`opencode-web-chat`](https://github.com/mondalaci/opencode-web-chat): one
process indexes several databases ("sources") and tags every result with its
origin. This app queries the `opencode` source, i.e.
`~/.local/share/opencode/opencode.db`. Clone it next to this repository and start
it with `pm2 start ecosystem.config.cjs` from there:

```bash
git clone https://github.com/mondalaci/opencode-search ../opencode-search
```

## How it is put together

```
electron/
  main.cjs           Main process: window, IPC registration, capture helper
  preload.cjs        contextBridge surface exposed as window.opencodeDesktop
  git.cjs            Git plumbing: repo detection, status, diff, stage/unstage
  static-server.cjs  Loopback static server for the production build
build/
  icon-source.png    1024×1024 master of the app icon: opencode's own "oc"
                     letters over the folder, composed from the two sources
  icon.png           512×512 app icon, resized from icon-source.png — the file
                     the window, the tray, the sidebar and the tab all use
  tray.png           64×64 tray base icon: the same icon, resized (panels draw a
                     ~20px slot, so a larger source downscales crisply on HiDPI)
public/
  icon.png           the same 512px icon, for the tab favicon (written by
                     `npm run icon`; the tab cannot reach outside the web root)
scripts/
  dev.mjs            Starts Vite, waits for the port, then launches Electron
src/                 Renderer (Vue 3 app inherited from opencode-web-chat)
  api/desktop.ts     Typed access to the preload bridge
  stores/projects.ts One conversation per project, plus its expanded chat list
  stores/archive.ts  Archived conversations, grouped by project, for viewing, restoring or deleting
  stores/git.ts      Source-control state: status polling, selection, diffs
  stores/layout.ts   Source-control panel width
  stores/desktopWindow.ts  Maximized state for the chromeless frame
  stores/sessionState.ts   Conversation state for every project and the tray
  stores/tray.ts     Rollup -> badge bitmap, tooltip and menu
  components/
    ProjectsPanel.vue     Projects sidebar (expandable into per-project chats)
    ConversationMenu.vue  Rename / archive actions of one conversation row
    ArchivePanel.vue      Archived conversations, grouped by project: click to view, plus restore and delete
    SourceControl.vue     Right-hand source-control panel (flat, full paths)
    DiffViewer.vue        Split/unified diff view
    FileViewer.vue        Read-only file view
    FilterBar.vue         The in-place sidebar filters (Ctrl+R, Ctrl+P)
    WindowControls.vue    Minimize / maximize / close for the frameless window
    WindowResizeHandles.vue  Edge grips, since a frameless window has no border
    ImageLightbox.vue     A conversation image, enlarged to the window
    DiffOverview.vue      The diff's change map
  utils/diff.ts      Unified-diff parsing and split-view alignment
  utils/fuzzy.ts     Subsequence matching for the incremental filters
  utils/highlight.ts Syntax highlighting for the diff and file views
  utils/changeMap.ts Draws the diff's change map
  stores/lightbox.ts Which conversation image is enlarged, if any
  utils/sessionState.ts  Pure state fold and tray rollup
  utils/trayIcon.ts  Draws the badge bitmap
```

### App icon

The application icon is opencode's own "oc" letters over a folder:
`build/icon-source.png` is the 1024px master, composed from those two pieces, and
`build/icon.png` is the 512px window, taskbar and dock icon cut from it. The
master is the file to edit — nothing generates it.

Everywhere the app shows its logo it shows that same file. The sidebar header and
the instance picker import `build/icon.png` directly, the tab loads `public/icon.png`
(the copy `npm run icon` writes, since a page cannot reach outside the web root),
the tray starts from `build/tray.png`, and the busy-tab spinner in
`src/stores/favicon.ts` draws the icon under its arc. There is no second drawing of
the mark to keep in step: edit `build/icon-source.png`, run `npm run icon`, and the
window, the dock, the tray, the sidebar, the picker and the tab all follow.

To regenerate the PNGs (needs ImageMagick on `PATH`):

```bash
npm run icon
```

`build/` is also electron-builder's default resources directory, so `icon.png`
and its derived siblings are picked up automatically if packaging is added
later.

### Why the renderer is served over HTTP

Production loads the UI from `http://127.0.0.1:<port>` (a throwaway static
server started by the main process) rather than `file://`. The opencode
server only accepts requests from loopback HTTP origins, so a `file://` page
would be blocked by CORS, and `localStorage` is unreliable there too.

### How the source control panel works

`electron/git.cjs` shells out to the user's `git`, so the panel reflects their
real repository — including their ignore rules, diff settings and rename
detection. The main process exposes four operations over IPC:

| Operation | Git command |
| --- | --- |
| Repository info | `rev-parse --is-inside-work-tree / --show-toplevel / --abbrev-ref HEAD` |
| Status | `git status --porcelain=v1 -z --untracked-files=all` |
| Diff | `git diff [--cached] --no-color -U3`, or `git diff --no-index /dev/null <file>` for untracked files |
| Stage / unstage | `git add -A -- <path>` / `git restore --staged -- <path>` |

Git has no change notification to subscribe to, so the panel re-scans the working
tree every 2.5 s while the window is visible (and immediately when the project
changes). Paths are validated against the repository root before any command
runs, and patches are capped at 2 MB.

Without git, or in a project that is not a repository, the panel degrades to an
explanatory notice instead of failing.

## The window

The app is **chromeless**: there is no OS title bar, so the header strip at the
top of the UI is the top of the window. The source-control panel is always
visible, so its header is the right-hand end of the window and carries the app's
own minimize / maximize / close buttons. Those header strips are also the
window's drag regions (`-webkit-app-region: drag`, with interactive elements
opted out), so the window is moved by its headers, and double-clicking one
maximizes it.

Two consequences of dropping the frame are handled explicitly:

- **Resizing.** Electron keeps edge resizing for frameless windows on Windows
  (`thickFrame`) but not on Linux, where the window manager has no decoration to
  grab. `WindowResizeHandles.vue` therefore draws invisible grips on all eight
  edges that resize the window through IPC. Pointer positions for those drags come
  from the main process (`screen.getCursorScreenPoint`) rather than
  `MouseEvent.screenX`, because a drag that moves the window also moves its
  coordinate space, and event deltas would feed back on themselves. While the
  window is maximized the grips are not rendered at all, since a maximized window
  cannot be resized.
- **The menu bar.** `Menu.setApplicationMenu(null)` removes it on Linux and
  Windows, which is also what stops a bare `Alt` press from pulling a menu bar
  down over the UI. macOS keeps a minimal menu, since its system menu bar carries
  the standard editing and window shortcuts (Cmd+C/V/W/Q). With no menu there is
  no reload or devtools accelerator either; for development, attach to the
  renderer with `--remote-debugging-port`.

## Conversation state and the tray

The tray is one icon summarising every project, so you can tell whether anything
needs you without the window in front. It rolls up in two steps:

1. **Conversation** — from the `session.*` events (`session.execution.*`,
   `session.status`, `session.idle`) and the server's global pending lists.
2. **Project** — the most actionable conversation wins:
   `blocked > retry/error > working > done (unacknowledged) > idle`.
3. **Tray** — the same precedence across projects, plus the counts.

The badge is baked into the icon bitmap, since trays have no numeric-badge API:
the mark's cog in monochrome — so it sits with the panel's own icons rather than standing out
as a coloured tile — carrying a state dot with the number of *projects* needing
attention (blocked, or done and not yet opened). The tooltip carries the
per-project breakdown. The glyph is drawn white with a hairline dark edge so it
reads on a light panel too, and the idle dot is a light grey because the muted
grey the sidebar uses disappears against a dark panel at tray size.

| Interaction | Behaviour |
| --- | --- |
| Left click | Toggle the window (where the platform delivers click events) |
| Double click | Raise the window, showing the last active conversation |
| Menu | The rollup, one entry per actionable project (and per conversation), then Open / Mute notifications / Quit |

On Linux the tray is an AppIndicator, which only really supports a menu: a left
click opens the menu rather than toggling the window, so "Open OpenCode Projects
Studio" is in the menu as well. Where the tray cannot be created at all, the app
logs a warning and carries on without it.

"Done" is sticky-unread: a turn that finishes while you are not looking marks its
conversation green, and opening it clears the mark. The set is kept in
`localStorage`, so it survives a restart.

### Attention chime

When the window is not focused (or is hidden) and a conversation starts wanting
the user — blocked, or finished with the result unopened — the app plays a short
two-note chime and, for a block, raises a desktop notification. A conversation
that is merely *working* never announces itself, nothing already announced
repeats, and Mute silences both the chime and the notifications.

"Blocked" covers two different asks, so they do not arrive sounding alike: a
question waiting on an answer gets the lower, growling figure, and a permission
or a finished turn gets the rising one. The chimes are synthesised with the Web
Audio API rather than shipped as files — they are the ones picked out of
[`sound-lab/index.html`](sound-lab/index.html), at the gains that lab measured as
equally loud — and Electron runs with `autoplayPolicy: "no-user-gesture-required"`
so they can sound without a click first.

### How the state feed works

One global event stream (`GET /api/event`) carries the events of *every* project,
each tagged with its `location`, so a single subscription keeps all the dots and
the tray current. A `BroadcastChannel` elects one leader tab to hold the stream
and fan the events out, so several open tabs do not each open their own
connection. Because a stream only reports changes, a bounded poll re-reads the
server's global pending permission and form lists to repair anything missed
while offline.

## Keyboard shortcuts

Hold `Alt` or `Ctrl` to reveal the key badges on the controls they trigger. The
two are separate layers — `Alt` carries the actions, `Ctrl` the two filters — and
each badge names its own modifier, so a letter never appears next to the wrong one.

| Shortcut | Action |
| --- | --- |
| `Ctrl`+`R` | Filter the projects sidebar in place |
| `Ctrl`+`P` | Filter the changed files in the source-control panel in place |
| `Alt`+`P` / `Alt`+`S` | Focus the projects list (arrow keys + `Enter`) |
| `Alt`+`L` | Expand or collapse the current project's conversations |
| `Alt`+`N` | New conversation |
| `Alt`+`F` | Search conversations |
| `Alt`+`M` / `Alt`+`A` / `Alt`+`E` | Model / agent / effort |
| `Alt`+`C` | Focus the composer |
| `Alt`+`X` | Stop the current turn |
| `Esc` | Close the open diff, search or archive page, or clear a sidebar filter (ending a Ctrl+P preview) |

The two filters narrow their list as you type (subsequences work: `kwchat` finds
`kilo-web-chat`), `↑`/`↓` move the selection, `Enter` opens it and `Esc` clears
it. `Ctrl`+`R` and `Ctrl`+`P` are Chromium's reload and print by default; both are
taken over here, which is what the app's own shortcuts require.

## Reading a diff

Both sides of the file are fetched — the index or `HEAD` for the old side, the
working tree or the index for the new one, depending on whether the change is
unstaged, staged or untracked — so the diff shows the file itself with the
changes marked inside it, the way an editor's side-by-side view does, rather than
only the hunks.

- The two halves are equal, each with a line-number gutter and its code, and long
  lines wrap inside their own half instead of scrolling away from their
  counterpart.
- Changed rows are tinted across gutter and code, with a saturated change bar on
  the gutter's outer edge.
- The **change map** down the right edge compresses the whole file into a strip:
  red where lines went, green where they arrived (left and right halves
  respectively, so a replaced line shows both), with the visible part marked.
  Clicking or dragging it moves through the file.
- `+n −m` in the header comes from the patch; the map and the bars come from the
  rows.
- Past 400 KB or 6000 lines a side, or for binary files, the sides are not sent
  and the view falls back to hunks with a gap marker and a "hunks only" tag.

Returning to the conversation — from a diff, a file view, or anywhere else —
lands on its end, since showing a diff unmounts the thread and it would otherwise
come back at the first message.

Selecting a project, or a conversation within one, puts the keyboard in the
composer: choosing something is the start of typing in it.

## Syntax highlighting

Diffs and the read-only file view are highlighted with the `highlight.js` bundle
the chat already ships. Two details make it work on diffs:

- Each side of a hunk is highlighted **whole** and then split back into lines,
  with tags that straddle a line break closed and reopened. Highlighting line by
  line would colour a block comment or a multi-line string as plain code.
- Line numbers, not positions, attach the fragments to rows: a deletion exists
  only on the old side and an addition only on the new one, so the two sides
  advance independently and an uneven hunk (three deletions, one addition) still
  lines up.

The language comes from the file name (extension, plus names like `Dockerfile`).
Unknown types, binary files and anything over 3000 lines render as plain text.
Message code blocks keep the single dark palette they always had, while the
editor surfaces use a theme-aware one defined in `style.css`, since they sit on
the app background rather than a dark code surface.

## Remembered state

Theme, sidebar and panel widths, the panel's visibility, the saved server and the
unread markers all live in `localStorage`, which is keyed by origin — so the UI is
served from a **fixed** loopback port (`45999`) rather than an ephemeral one. If
that port is taken, the app falls back to an ephemeral port and says so in the
log, because settings will not persist for that run.

## Notes and limitations

- One conversation per project is deliberate: a collapsed project row shows its
  newest conversation. The row's chevron (`Alt`+`L`) expands the project in
  place to list all of its conversations; older ones are also reachable through
  the conversation search (`Alt`+`F`).
- Opening a project that has no conversation yet creates its first one.
- Renaming and archiving are on each conversation's own hover menu: the collapsed
  project row's names its newest conversation, and every row of an expanded list
  carries the actions of the chat it belongs to. Both work against the
  conversation's own project, so no project switch is needed. Archived
  conversations leave the active lists and search results, and can be restored or
  permanently deleted from the header's archive button. Clicking an archived
  conversation opens it read-only — its composer is replaced by a notice — so it
  can be reviewed before deciding; deleting asks for confirmation on the row.
- The diff viewer renders text patches; binary changes are reported as such.
- Requires `git` on `PATH` for the source-control panel.
- The v2 API has no per-message tool toggles or session sharing, so the tools
  list (and its `Alt`+`T` toggle) and the share button are gone; the source-control
  panel still uses the desktop's own `git` rather than the server's `/api/vcs`.
- Questions are surfaced as v2 **forms** (`/api/form`), and tool calls are streamed
  from the `session.tool.*` events. A question card carries only what is chosen —
  options and a Yes/No — while a free-form answer is typed into the composer,
  which sends it as the reply. The card answers itself the moment its last choice
  lands, and keeps a Submit button only when nothing on it can end the question (a
  multiple choice, or a step finished in a browser); `Alt`+`X` withdraws a question
  instead.
- If `ELECTRON_RUN_AS_NODE` is set in the environment, Electron behaves as plain
  Node; `npm run app:dev` clears it for the child process, and the main process
  exits with an explanatory message if it is still set.
- `KPS_CAPTURE=<file> npm run app` renders the window, writes a PNG of it and
  exits — handy for screenshots and CI checks. `KPS_CAPTURE_DELAY` (ms, default
  `4000`) tunes how long it waits before capturing.
