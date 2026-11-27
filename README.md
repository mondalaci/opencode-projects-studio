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

- **Chats sidebar** — split in two. The top half lists the newest conversations
  of *every* project, newest first, each row naming the project it belongs to above
  the chat's own subject, with the state dot centred on the two lines and the
  relative time staying readable while the pointer is on the row (the actions
  button steps in beside it rather than over it); it is one bounded request from
  the start, not a pass over each project's history. A conversation that becomes
  fresher while the list is on screen — a finished turn, an answered block — moves
  to the top with its neighbours: the rows travel to their new places instead of
  snapping, so the reorder is something the eye can follow.
  The bottom half lists only the open project's own conversations (the newest 50),
  under that project's name, below a hairline border that separates the two
  halves. The divider between them drags to give either half more room
  (double-click evens them out, or focus it and use the arrows), and the share is
  remembered. The open project is chosen from the **project switcher** at the top
  of the bottom half (`Ctrl`+`R`, or `Alt`+`P`), which searches projects as it is
  typed and also holds **Add project**; its `⋯` menu on the bottom half's header
  hides or deletes it (behind a confirmation), and a **Hidden** section folds away
  under the split to bring one back. Every conversation's own `⋯` menu renames it
  or deletes it for good, also behind a confirmation.
- **Diff panel** — a permanent right-hand panel listing the uncommitted changes of
  the active project's repository as a flat list of file paths, with the count
  beside the title and the staged ones under their own heading. It re-scans the
  working tree on a timer, so there is nothing to refresh by hand; the file names
  keep their two-tone scheme (a dimmer directory leading to a bright file name)
  and the status lives in the letter beside them. Its left edge is the divider
  the chats sidebar has on its right — one make of separator either side of the
  conversation: drag it, double-click it to return that panel to its default
  width, or focus it and use the arrows; the width is remembered.
- **Diffs** — clicking a file in that panel opens it in the editor area: the
  whole file on both sides, split or unified, with line numbers, syntax
  highlighting, `+n −m` statistics, a change map down the right edge and change
  bars in the gutter. Clicking an image in a conversation enlarges it to the
  window, fitted; the `1:1` button (or `1`) shows one image pixel per screen
  pixel — the display's own scaling is divided out —
  where a click on the image no longer closes the overlay and dragging pans it.
  Clicking the ground around it, or Escape, returns to the conversation.
- **Conversation state dots** — every listed conversation carries a dot: red
  blocked, amber working, green done and not yet opened, grey idle. A project's
  own state is the most actionable of its conversations. In the all-projects half
  a conversation that waits for a human tints its whole row with the state's
  colour — green for an unread finish, red for a blocked turn — so it is visible
  without reading the dots; working and idle keep the list background. The tint is
  a wash rather than a solid fill, so the text stays in the theme's own ink and one
  blocked row does not drown the list around it. A fill that has just ended (the
  conversation was opened, or its block was answered and the turn stopped) does
  not blink out: it shrinks away to the right over six seconds. A conversation
  that goes straight back to work drops the tint at once and shows its pulsing
  amber dot instead, so a red or green sweep never plays over a running turn.
- **The open conversation** — in either half of the sidebar, the conversation on
  screen is the only row with a ring around it. A filled row would have to fight
  the red and green state tints for the same ground, so the ring sits on top of
  the tint instead: a row that is both open and waiting for a human shows both
  things at once. The ring is drawn in the theme's strongest ink, so it outranks
  the tints in contrast without spending the accent colour.
- **Compact view** — an application-wide switch in the conversation's header
  between the full transcript and the text alone: a turn's reasoning blocks and
  tool calls fold behind one line naming what they hold, and the prompts and
  answers read as one piece. The line opens the turn again, in the order it
  happened.
- **Tray icon** — the same state rolled up across all projects into one badge,
  with a menu that jumps straight to the conversation that needs you; a project
  with several conversations worth showing becomes a submenu of them.

Chat and diffs share the centre pane: opening a diff replaces the conversation
until you go back (the `←` button or `Esc`).

## Screenshots

Chats sidebar, chat, and the source-control panel for the active project:

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
  "hideProjects": ["chats", "vocab"]
}
```

`hideProjects` lists projects to keep out of the sidebar. Each entry matches
either a project's folder name (when it has no `/`) or its absolute canonical
directory (when it does); `*` matches any run of characters except `/`, and `**`
matches any run including `/`. Hidden projects still exist on the server — they
are only omitted from this app's list, and matching is case-sensitive.

The sidebar's **Hide project** action appends a project's canonical directory to
this list, and **Unhide project** removes whichever entries match it, so the file
can be managed from the UI as well as by hand. Writing needs the desktop app (a
browser page cannot touch the file the static server serves); in a browser the
actions are disabled and the served list is still honoured.

Deleting a project is a different thing: opencode's HTTP API has no delete, so
**Delete project…** removes the project's row — and, by the schema's cascades,
its conversations, messages, parts, todos and event aggregates — from the local
opencode database (`~/.local/share/opencode/opencode.db`, or `$OPENCODE_DB`).
`GET /api/project` reads that table directly, so the project is gone from the
list immediately; only other clients that cached it keep it until they reload.
opencode's `global` placeholder project cannot be deleted.

Conversation search (`Alt`+`F`) uses the shared
[**opencode-search**](https://github.com/mondalaci/opencode-search) service (a
small Bun FTS5/BM25 index over message text, listening on `127.0.0.1:27184`)
when it is running, and falls back to the server's own title search when it is
not. The search view's header shows which one answered ("Content search" or
"Fallback · titles"). The scope chip beside the field chooses whether the
search covers the open project only (the default, matching the sidebar) or
every project; the choice is remembered across restarts. Results from other
projects name their project, and opening one switches to it.

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
  main.cjs           Main process: window, IPC registration, capture helper,
                     native folder picker
  preload.cjs        contextBridge surface exposed as window.opencodeDesktop
  git.cjs            Git plumbing: repo detection, status, diff, stage/unstage
  opencode-db.cjs    Project deletion, straight in opencode's own SQLite database
  runtime-config.cjs Read/write of opencode-projects-studio.json (hideProjects)
  static-server.cjs  Loopback static server for the production build
build/
  icon-source.png    1024×1024 master of the app icon: opencode's own "oc"
                     letters over the folder, composed from the two sources
  icon.png           512×512 app icon, resized from icon-source.png — the file
                     the window, the tray and the tab all use
  tray.png           64×64 tray base icon: the same icon, resized (panels draw a
                     ~20px slot, so a larger source downscales crisply on HiDPI)
public/
  icon.png           the same 512px icon, for the tab favicon (written by
                     `npm run icon`; the tab cannot reach outside the web root)
scripts/
  dev.mjs            Starts Vite, waits for the port, then launches Electron
src/                 Renderer (Vue 3 app inherited from opencode-web-chat)
  api/desktop.ts     Typed access to the preload bridge
  stores/projects.ts One newest conversation per project, plus the recent list the tray rolls up
  stores/recentChats.ts  The all-projects chat list: one bounded session query, kept live by events
  stores/hiddenProjects.ts  The hidden-project list, read and written through the runtime config
  stores/git.ts      Source-control state: status polling, selection, diffs
  stores/layout.ts   Source-control panel width
  stores/reading.ts  The full / compact reading-view choice
  stores/desktopWindow.ts  Maximized state for the chromeless frame
  stores/sessionState.ts   Visible conversation set per project, the tray state and the unread marks
  stores/tray.ts     Rollup -> badge bitmap, tooltip and menu
  stores/find.ts     Find-in-conversation state (Ctrl+F)
  stores/filter.ts   The source-control filter's open state (Ctrl+P)
  stores/projectPicker.ts  The project switcher's open state (Ctrl+R, Alt+P)
  components/
    ChatsPanel.vue        The split sidebar: all projects' chats above, the open project's chats below
    ProjectPicker.vue     The bottom half's project switcher, and the Add project entry
    ProjectMenu.vue       Hide / unhide / delete actions of one project
    ConversationMenu.vue  Rename / delete actions of one conversation row
    ConfirmDialog.vue     Modal confirmation before a project or conversation is deleted
    SourceControl.vue     Right-hand source-control panel (flat, full paths)
    DiffViewer.vue        Split/unified diff view
    FileViewer.vue        Read-only file view
    FilterBar.vue         The in-place source-control filter (Ctrl+P)
    FindBar.vue           Browser-style find bar over the open conversation (Ctrl+F)
    WindowControls.vue    Minimize / maximize / close for the frameless window
    WindowResizeHandles.vue  Edge grips, since a frameless window has no border
    ImageLightbox.vue     A conversation image, fitted or at 1:1
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

Everywhere the app shows its logo it shows that same file. The instance picker
imports `build/icon.png` directly, the tab loads `public/icon.png`
(the copy `npm run icon` writes, since a page cannot reach outside the web root),
the tray starts from `build/tray.png`, and the busy-tab spinner in
`src/stores/favicon.ts` draws the icon under its arc. There is no second drawing of
the mark to keep in step: edit `build/icon-source.png`, run `npm run icon`, and the
window, the dock, the tray, the picker and the tab all follow. The sidebar carries
no copy of it — its top row belongs to the chat lists.

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
maximizes it. The sidebar spends no height on a header of its own: its search and
new-chat buttons float over the top of the chat lists, and a bare grip of the same
height across that row is the dragging surface there.

The conversation pane's header names what is open in two parts: the project the
conversation lives in, as a muted chip, and then the conversation's own title in
the theme's strongest text. The chip is a different shape and weight on purpose,
so a long project name and a long title never read as one run-on string.

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

A project does not roll up from a single conversation. Its tray entry — and its
submenu — lists every conversation that is *recent* or wants attention: anything
that changed in the last 24 hours, plus anything blocked or finished-and-unopened
however long it has been waiting, plus the project's newest conversation. A
conversation that got a notification therefore keeps its line even after a newer
one arrives, and a project that has been sitting on an unanswered block still
counts as needing you. The sidebar's all-projects half is the newest
conversations across projects instead, so an idle one that has aged out of it is
found through the search over conversations.

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
| Menu | The rollup, one entry per actionable project, a submenu when it lists several conversations, then Open / Mute notifications / Quit |

On Linux the tray is an AppIndicator, which only really supports a menu: a left
click opens the menu rather than toggling the window, so "Open OpenCode Projects
Studio" is in the menu as well. Where the tray cannot be created at all, the app
logs a warning and carries on without it.

"Done" is sticky-unread: a turn that finishes while you are not looking marks its
conversation green, and opening it clears the mark. The set is kept in
`localStorage`, so it survives a restart. The app only ever *reads* that marker
when you open a conversation or when it watches a turn finish — it never stamps
a conversation as seen just because the row is on screen. A finish that arrived
while the app was closed is adopted as unread instead, so its tile stays until
you open it.

### The web chat app's conversations

[OpenCode Chat](https://github.com/mondalaci/opencode-web-chat) — the browser UI
for the same servers — reports its conversations here too, so one tray covers
both. Its tabs POST a small JSON report to a loopback endpoint this app's main
process listens on:

| | |
| --- | --- |
| Where | `http://127.0.0.1:45998/status` (`electron/status-server.cjs`) |
| When | on every change, on a 20-second heartbeat, and once as a beacon on unload |

A browser tab cannot be reached, so it pushes; nothing has to be configured, and
with the web app closed the endpoint simply hears nothing. Each tab reports under
its own id, so closing one leaves the others' status standing, and a report that
stops arriving is dropped after `EXPIRY_MS` — a killed tab never sends its beacon,
and its dot must not stand forever. The conversations themselves are folded by id,
because every tab lists the same project's: three tabs holding two conversations
that want attention are two, not six.

Web chat conversations are shown, but kept visibly apart from studio's own:

- **A separate dot, bottom-LEFT** — studio's own conversations keep the
  bottom-right one. Two corners, so neither can hide the other, and one rule for
  both: always drawn, the same base size, and a number when that corner has one to
  report. A grey dot therefore means the same thing in either corner. What the two
  numbers *count* differs, because what the two apps hold differs — studio counts
  the **projects** that want the user, the web chat counts the **conversations**
  that do (blocked, or finished and not yet looked at). When both corners carry a
  number they take the smaller size, since two large ones will not fit side by side
  in one 64px icon.
- **A section in the menu**, one entry per conversation that has something to
  say, labelled `<project> — <title> (<reason>)`. Clicking one opens it in the
  browser rather than raising this window, because the browser is what holds it.
- **A line in the tooltip**, `OpenCode Chat — b blocked, w working, d done (n open)`.

Nothing is *listed* or *counted* for a web chat conversation that is idle: the
tray has nothing to say about those, and a hundred idle conversations would bury
the one that does. Only the conversations with news cross the wire. The dot is a
different matter — it reports the app, not its conversations, so it stays.

The chime and the notification policy below covers these conversations on exactly
the same terms as studio's own, and `previousAttention` is keyed by conversation
id — which is server-wide, so a conversation open in both apps announces itself
once rather than twice.

### Attention chime

When the window is not focused (or is hidden) and a conversation starts wanting
the user — blocked, or finished with the result unopened — the app plays a short
two-note chime and, for a permission block, raises a desktop notification. A
question gets the chime only: it is answered in the app, so the popup would
interrupt more than it helps. A conversation that is merely *working* never
announces itself, nothing already announced repeats, and Mute silences both the
chime and the notifications. The desktop popup does not time out on its own
(`timeoutType: "never"`): it stays until it is dismissed or clicked, so a block
that arrives while you are on another workspace is still there when you come
back.

"Blocked" covers two different asks, so they do not arrive sounding alike: a
question waiting on an answer gets the lower, growling figure, and a permission
or a finished turn gets the rising one. The chimes are synthesised with the Web
Audio API rather than shipped as files, their gains balanced so neither of them
is the one that shouts — and Electron runs with
`autoplayPolicy: "no-user-gesture-required"` so they can sound without a click
first.

The audio context is rebuilt after a system resume or an audio device change: a
USB headset that is re-enumerated on wake leaves the old context silent even
though it still reports running. The tray's **Test sound** item plays the chime
on demand, so the audio can be checked without waiting for a conversation.

### How the state feed works

One global event stream (`GET /api/event`) carries the events of *every* project,
each tagged with its `location`, so a single subscription keeps all the dots and
the tray current. A `BroadcastChannel` elects one leader tab to hold the stream
and fan the events out, so several open tabs do not each open their own
connection. Because a stream only reports changes, a bounded poll re-reads the
pending-permission and pending-form lists of the projects that currently hold a
blocked conversation, and reconnecting rebuilds the whole picture, to repair
anything missed while offline.

An auto-generated title is one of those changes: the server emits a
`session.renamed` frame (id + title, located on the frame rather than the
payload), which updates the project's newest conversation and both sidebar lists
in place. Without it a fresh conversation sat as "Untitled" until its row was
opened, which is what refetched the session.

## Reading a conversation

The conversation's header carries the switch between the two ways of reading it.
The default, **full view**, draws everything the model did: its reasoning blocks
and every tool call, in the order they happened. **Compact view** — the switch
between the session figures and the theme toggle — draws only what there is to
read: the prompts and the replies, with the steps that produced them folded behind
one line per turn.

The line names what it holds — "6 tool calls, 2 reasoning blocks" — and opens the
turn again as it happened; clicking it once more folds it away. The switch in the
header is what returns to the full transcript, so a conversation read compactly
does not lose anything.

A running turn is the one exception, and only until it writes: while it has
produced nothing to read yet, its reasoning and calls are drawn as usual. They are
the only sign of what is happening, and the reader would otherwise watch a caret
with nothing above it. The moment the first text arrives, the turn's steps fold
away and the text stands on its own. A turn that never writes — one stopped while
thinking — keeps its steps for the same reason. A composed message (the drafting
tool's output) is content rather than a step, and so is a picture a tool returned
— a screenshot read from disk, an image the model generated — so compact view
keeps both, image cards included. A turn that has produced only one of them is
folded once it is there to read.

The choice is application-wide rather than per conversation: it is how the reader
likes to read, which does not change with the project.

## Keyboard shortcuts

Hold `Alt` or `Ctrl` to reveal the key badges on the controls they trigger. The
two are separate layers — `Alt` carries the actions, `Ctrl` the filters, the
project switcher and the two walk-the-list pairs — but holding either one reveals
both, so reaching for `Ctrl` to find the filters also shows that `Alt`+`A` jumps to
the next conversation that needs you. Each badge names its own modifier, so a
letter never appears next to the wrong one.

| Shortcut | Action |
| --- | --- |
| `Ctrl`+`F` | Find in the open conversation (browser-style find bar) |
| `Ctrl`+`R` | Open the searchable project switcher at the top of the bottom half |
| `Ctrl`+`P` | Filter the changed files in the source-control panel in place |
| `Ctrl`+`↑` / `Ctrl`+`↓` | Switch to the previous / next conversation in the open project |
| `Ctrl`+`PageUp` / `Ctrl`+`PageDown` | Switch to the previous / next conversation in the all-projects list |
| `Alt`+`P` | Open the searchable project switcher (as `Ctrl`+`R` does) |
| `Alt`+`A` | Jump to the first conversation that needs you (blocked or unread finish) |
| `Alt`+`S` | Focus the all-projects chat list (arrow keys + `Enter`) |
| `Alt`+`L` | Fold the open project's conversation list away and back |
| `Alt`+`N` | New conversation |
| `Alt`+`F` | Search conversations |
| `Alt`+`M` / `Alt`+`E` | Model / effort |
| `Alt`+`C` | Focus the composer |
| `Alt`+`X` | Stop the current turn |
| `Alt`+`↑` / `Alt`+`↓` | Jump to your previous / next message in the conversation |
| `Esc` | Close the open diff or search page, or clear a sidebar filter (ending a Ctrl+P preview) |

The source-control filter narrows its list as you type (subsequences work: `kwchat`
finds `kilo-web-chat`), `↑`/`↓` move the selection, `Enter` opens it and `Esc`
clears it. `Ctrl`+`R` and `Ctrl`+`P` are Chromium's reload and print by default;
both are taken over here — the reload key opens the project switcher, the print key
the source-control filter — which is what the app's own shortcuts require.

`Ctrl`+`F` opens a find bar over the open conversation and highlights every match
in it, painting the active one in the solid accent colour. `Enter` and `Shift`+`Enter`
walk forward and back — the thread scrolls smoothly to centre each one — and `Esc`
closes the bar. Unlike `Alt`+`F`, which searches across conversations, this searches
only the conversation on screen — the same way a browser's find works on a page.

`Ctrl`+`↑` and `Ctrl`+`↓` walk the open project's conversations in the order the
bottom half of the sidebar lists them, newest first, so `↑` moves toward the newer
conversations and `↓` toward the older, wrapping at either end.

`Ctrl`+`PageUp` and `Ctrl`+`PageDown` walk the all-projects list in its own order —
the top half of the sidebar, newest first across every project — and open each
conversation they land on, switching project when it lives elsewhere. They are the
twin of `Ctrl`+`↑` / `Ctrl`+`↓`, one list higher up.

`Alt`+`A` jumps straight to the topmost conversation that wants a human — a red
(blocked) or green (unread finish) row of the all-projects list. Opening it
acknowledges it, so pressing the key again moves on to the next one.

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
- Within a replaced pair the characters that actually changed carry a deeper tint
  than the row's, so `count` → `counts` marks the `s` alone and a one-word edit
  reads at a glance. The lines are compared as tokens, not characters, so the
  untouched middle of a line is left alone; lines that differ wholesale keep the
  row tint by itself.
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
composer: choosing something is the start of typing in it. What has been typed —
and what is attached — belongs to the project it was typed in, so switching
projects parks it there and brings the other project's own text back.

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

Theme, the reading view, sidebar and panel widths, the chat lists' split, the
panel's visibility, the saved server and the unread markers all live in
`localStorage`, which is keyed by origin — so the UI is served from a **fixed**
loopback port (`45999`) rather than an ephemeral one. If that port is taken, the
app falls back to an ephemeral port and says so in the log, because settings will
not persist for that run.

## Notes and limitations

- The all-projects half of the sidebar holds the newest 50 conversations across
  every project, read in one request; the bottom half holds the open project's
  newest 50, which is the list the app already loads when it opens the project.
  Anything older is reachable through the conversation search (`Alt`+`F`), which
  reads the whole history.
- Opening a project that has no conversation yet creates its first one.
- Renaming and deleting are on each conversation's own hover menu, in either
  half of the sidebar. Both act on the conversation's own project, so no project
  switch is needed. Deleting a conversation removes it and its messages from
  opencode for good, and asks for confirmation first.
- The open project's `⋯` menu, on the bottom half's header, carries **Hide** —
  which keeps it out of the sidebar by adding it to the runtime config's
  `hideProjects` — and **Delete**, which removes it and all of its conversations
  from opencode's database after a confirmation. The **Hidden** section under the
  split lists the hidden ones, with **Unhide**. Hiding is a studio-side view;
  deleting is real, and cannot be undone.
- The project switcher's **Add project** entry **adds a project directory**: the
  desktop app opens the OS folder picker, a browser asks for the absolute path by
  hand. opencode has no "add project" call — a directory becomes a project the
  moment a request is scoped to it — so the app resolves the directory with
  `GET /api/location` (which registers it and answers with its canonical path),
  then opens it like any other, creating its first conversation if it has none.
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
  instead. A typed answer is read back out of the answered tool call's own metadata
  and shown in the thread as a message of its own, so the reply reads like any other
  turn rather than only as the tool row's output; a picked option stays on the tool
  row, since the card that offered it is the thing being answered.
- Links in a conversation (and anywhere else in the app) always open in the OS
  browser, never inside the window: a left click, a middle click and a
  `target="_blank"` all end up at `shell.openExternal`. A same-origin navigation
  is let through, because a reload arrives as one.
- If `ELECTRON_RUN_AS_NODE` is set in the environment, Electron behaves as plain
  Node; `npm run app:dev` clears it for the child process, and the main process
  exits with an explanatory message if it is still set.
- `KPS_CAPTURE=<file> npm run app` renders the window, writes a PNG of it and
  exits — handy for screenshots and CI checks. `KPS_CAPTURE_DELAY` (ms, default
  `4000`) tunes how long it waits before capturing.
