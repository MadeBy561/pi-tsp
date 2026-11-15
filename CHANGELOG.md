# Changelog

All notable changes to pi-tsp are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-11-15

Brings pi-tsp level with claude-tsp, its sister surface for Claude Code.

### Added

- A written figure file is drawn as a figure above its source, as oh-my-pi
  draws it: SVG and Mermaid files, and 3D models (`.obj`, `.ply`, `.stl`,
  `.gltf`, `.wrl`, `.usd`…).
- Settings dropdowns open on click and with Enter; arrows move, Enter picks,
  and a click elsewhere closes the dropdown before the window.

### Fixed

- The surface's stylesheet was never applied (it was sent before Tern had
  said it takes styles).
- The transcript column takes the composer's width, so a reply starts where
  the composer does instead of to its left; the error banner and text dialogs
  follow it.
- The rewind page keeps that column instead of running edge to edge.
- The settings window opens at its top, with no row hidden under its header.
- Session, outline and preview titles drop Markdown marks and table syntax.
- A chart labels a bar with the value as written (`$1.20`, not `$1.2`).

## [2.0.2] - 2026-11-15

### Fixed

- A resumed session shows each subagent's stored tool count and duration
  instead of a made-up "1ms".

## [2.0.1] - 2026-11-15

### Fixed

- A sheet's buttons (Close, Copy report, Compact now) sit in the overlay's
  footer, so a long body such as a subagent transcript scrolls under them
  instead of pushing Close off the window.

### Changed

- README screenshots retaken on a neutral demo setup; unused images removed.

## [2.0.0] - 2026-11-15

A rewrite in TypeScript on Tern's SDK (`@stencil-hq/tern`), drawn with Tern's
native components the way omp's surface is.

### Changed

- The surface is `inline`, like a terminal program's output, instead of a
  separate screen. The transcript is the pane's scrollback.
- The look comes from Tern: the composer, tool rows, pickers, settings window
  and approval panel are Tern's own components. pi-tsp's stylesheet is gone.
- The status strip under the composer is gone. Its facts (session name, plan
  mode, extension status text) sit inside the composer bar.
- The package ships compiled `dist/`; `npm install` from git builds it.
  Node 22.19 or newer is still required.
- `~/.pi-tsp` no longer gets a synthetic `-alias` copy of a single model, and
  `theme` and `defaultThinkingLevel` are no longer forced in a new
  `settings.json`.

### Added

- Settings window (`/settings`) with typed rows instead of a five-row list.
- Model picker with search, provider scopes, capability tabs, context and
  price columns and a detail pane. Session picker with search, a this-folder /
  all-projects scope, preview, rename and delete.
- Search in every picker; `/tree`, `/fork`, `/copy` and prompt history
  (Ctrl+R) are searchable timelines with a preview.
- Completion popup at the caret for `/` commands and `@` files, with fuzzy
  matching over the project's files.
- Composer editing: selection, word motions, multi-line caret movement, undo
  and redo, kill and yank, large pastes as chips, `$EDITOR` (Ctrl+G).
- Per-turn footer with duration, tokens and cost, and a copy button.
- A failed request gets its own frame with Retry, Copy error and Switch model.
  An automatic retry shows its countdown.
- Todo HUD above the composer while work is open; each `todo` call also shows
  its checklist where it happened.
- `!command` output streams as it arrives, and Esc cancels the command.
- Tool arguments stream: an edit's diff and a write's content appear as the
  model produces them.
- Extension `setStatus` text and `setWidget` lines are drawn. They were
  collected and dropped before.
- Session details sheet (`/session`) and a keyboard shortcuts sheet.
- The approval panel shows what is being approved and the request's own
  options, and can be answered from the keyboard.
- Model makers' logos on the composer's model chip and in the model picker. A
  model served through a gateway or a local endpoint shows its maker's logo.
- `grep` results grouped per file, numbered as in the file, matches marked.
- A token usage line under each reply (off by default; Settings › Display).
- A failed turn's error stays pinned above the composer until dismissed or the
  next turn.
- Application shortcuts follow pi's `keybindings.json` (`app.model.select`,
  `app.tools.expand`, …), read from `~/.pi-tsp/agent/` and then `~/.pi/agent/`.
- Display settings persist in `~/.pi-tsp/display.json`.
- A tool call waiting on an approval says so instead of showing as running.
- `/context`: what fills the context window, with an estimated split by kind
  and a Compact button. The composer's meter opens it.
- `/login` and `/logout` hand the pane to pi's own sign-in and return.
- A frame Tern rejects is followed by a full redraw, so the view cannot stay
  out of step with what Tern holds.
- Vim keys in the composer (Settings › Display): Normal, Insert, Visual and
  Visual-line modes, counts, motions, the `d` `c` `y` operators, `iw`/`aw`.
- `/rewind`: a page replaying the transcript with the chosen message marked
  and what follows it dimmed; Enter forks from there.
- The bash tool's command is drawn in Tern's command pane: the script as
  commands, flags, strings and operators, and a script handed to an
  interpreter shown as that language.
- Bash calls are traced: each line shows whether it ran, failed or was never
  reached, how long it took and how many times. `/inspect` (or Inspect in the
  pane's menu) opens the run in an inspector that replays it step by step.
  A bundled extension adds a one-line prelude to the call that turns on
  bash's own tracing into a private file; only line numbers and times are
  kept, never the expanded text. A command that uses `set -x` or `PS4`
  itself is left alone. `/trace` turns it off.
- `$EDITOR` and `/login` hand the whole pane over and take it back with the
  transcript intact.
- A table of numbers in a reply is followed by a bar chart of it, drawn in
  the theme's colours (Settings › Display to turn it off).
- `/skill:name` prompts show the skill as a chip with its text folded away
  instead of the whole expanded prompt.
- Compact tool calls (Settings › Display): each call one line, runs of them
  closed up.
- A run that ends with todos still open leaves a reminder of them.
- Background subagents still running show as a pill above the composer; a
  click lists them.
- `/context` is worked out from pi's own counts for each request: what the
  model wrote, and by subtraction what each tool result and message added.
  Only the first request, which holds the system prompt, the tool schemas
  and your first message in one number, is split by an estimate.
- A `!` draft shows a bash chip in place of its sigil and highlights as bash.
- Editor keys follow `keybindings.json` too (`tui.editor.*`, `tui.input.*`).
- In a Tern pane the surface opens and draws before Tern's `hello` reply
  arrives. A mid-draft keystroke goes out as a `splice` of the changed range.
- A lost frame acknowledgement no longer stalls the surface: after five
  seconds it draws on.
- `/outline`: the transcript's landmarks (your messages, tool calls, failures);
  Enter scrolls to one.
- Images a model returns are drawn in its reply. A reply from a different model
  than the one before it is marked.
- The transcript is reconciled block by block: a frame costs what changed, not
  the session's length. With 10,000 rows a streamed word takes about 2 ms to
  build and diff (it was about 50 ms through a whole-view diff).

### Fixed

- Ctrl+C no longer discards the rest of its input chunk, which could drop
  Tern's acknowledgements and freeze the surface.
- "Always this session" answered "Allow once". Every option now returns
  itself, for any extension's `select`.
- Reordered or reparented nodes, large and non-ASCII frames, split escape
  sequences and chunked inbound messages are handled by the SDK's reconciler
  and codec instead of hand-written ones that got each of them wrong.
- Two read groups in one transcript no longer share node ids.
- A tool call with no result in a resumed session no longer spins forever.
- A failed edit shows its error instead of a diff of the attempt.
- A request that is retried automatically leaves one error in the transcript,
  the final one, instead of one per attempt.
- Escape in a picker with a delete confirmation armed no longer resumes the
  session; Enter while armed confirms the delete.
- Keys typed while pi starts are kept and delivered, instead of crashing the
  surface when they included Enter.
- The `undo` and `send` events advertised in `hello` are honoured: a blank
  `send` is a no-op and a displaced draft is kept for recall.
- Collapsing a block by hand is remembered instead of reset on the next frame.

### Removed

- `/trust`, `/search`, `/todos`, `/import`, `/scoped-models`, `/reload` and
  `/changelog`. `/search` is covered by search in `/copy` and `/tree`; the rest
  were toasts or thin wrappers.
- Session pinning in the resume picker.
- `PI_TSP_COMPACT`, `PI_TSP_FRAME_OPS` and `PI_TSP_FRAME_LOG`. `PI_TSP_RECORD`
  records every message in both directions as JSONL.

## [1.1.0] - 2026-11-09

### Added

- `@tintinweb/pi-subagents` support. Its `Agent` tool is a subagent run just as
  pi-subagents' `subagent` is, so both now become agent cards with the run's
  type, model, tool count, tokens and elapsed time taken from the runtime's own
  details.
- Subagent transcripts are read from the per-agent `.output` file the runtime
  streams, derived from the agent id and the session id in `get_state`.

### Fixed

- The surface resolved pi from a hardcoded `/usr/local/bin/pi` instead of
  `PATH`, so a Homebrew-on-arm64, asdf/mise or npm-prefix install crashed with
  `spawn /usr/local/bin/pi ENOENT` while the launcher's own fallback worked.
  Both now share one resolver, and a spawn failure is reported in the surface
  instead of taking the process down as an unhandled `error` event.
- `PI_TSP_PI` is honoured by both the launcher and the surface.
- A `todo` tool the user's own config already registers no longer collides with
  pi-tsp's bundled `todo` extension. pi treats the duplicate as an extension
  load error and the session died with it, so the surface now skips its own
  extension when the user's extensions already own that tool name.
- A dead pi child no longer reports `pi is not running`: the exit code and its
  stderr stay on screen instead of being replaced by the rejected command.
- Spawn failures now settle pending RPC commands immediately and retain the
  spawn error, including while the surface is starting; a missing pi no longer
  waits for `get_state` to time out before showing the path.
- A background `@tintinweb/pi-subagents` completion now settles its agent card
  (status, stats, output and transcript path) instead of leaving it running and
  adding a second notification row.
- Tool-name collision detection now reads symlinked extension files and explicit
  `--extension` paths, so a dotfiles-style `todo` link or an extension supplied
  on the command line is recognised alongside a regular config file.

## [1.0.25] - 2026-11-09

### Changed

- Refreshed the README screenshots under versioned filenames so GitHub's
  image cache cannot serve an older launch state. The model provider logo is
  inline in the composer pill; the screenshots now match the live surface.
## [1.0.24] - 2026-11-09

### Fixed

- macOS clipboard images now fall back to TIFF and convert through `sips`
  when the pasteboard does not expose PNG data (the common screenshot case).
- Finder `Cmd+C` image files are read from the pasteboard's file URL
  representation and attached as images.
- Bracketed-paste completion exposes its text to the surface, so empty paste
  and pasted image paths work through the same path as Ctrl+V.

## [1.0.23] - 2026-11-09

### Added

- `Ctrl+V` / `Cmd+V` clipboard image paste. The surface reads the host
  clipboard directly (`wl-paste`/`xclip`/`xsel` on Linux, the macOS
  pasteboard, PowerShell on Windows), stages the image in the composer with
  a thumbnail and detach chip, and sends it through pi's native `prompt`
  image blocks.
- Empty clipboard paste opens the image path; plain text falls back to a
  normal paste when the clipboard has no image.
- Image file paths pasted into the composer are attached as images.
- `/attach` now uses the same image reader and MIME validation.

## [1.0.22] - 2026-11-09

### Changed

- The transcript now shares the composer's centered 96ch column, with
  consistent left/right margins and scrollbar clearance.
- Added breathing room above the brand row and below the last message.
- Markdown paragraphs and headings have a cleaner vertical rhythm.
- Ordered and unordered lists use a real hanging indent; two-digit markers
  such as `10.` are no longer clipped.

## [1.0.21] - 2026-11-09

### Fixed

- Ctrl+C exit now closes the Tern surface exactly once. The old exit
  handler sent a second close after the quit path, which made Tern emit
  `{"ev":"error","sf":"pit","msg":"unknown surface pit"}` into the terminal.

## [1.0.20] - 2026-11-09

### Fixed

- The transcript no longer calls `reveal("tail", "end")` on every streamed
  token. That made the viewport snap to the bottom continuously and made
  scrolling up impossible while a response was generating.
- Auto-follow now happens only when the transcript gains a new row (user
  message, assistant block, tool result), not on token deltas. Scroll up
  during streaming and the viewport stays where you put it.

## [1.0.19] - 2026-11-09

### Fixed

- Subagent cards now consume pi-subagents' `subagent-async` widget snapshots:
  queued, running, complete and failed states update in place instead of
  staying detached.
- Async child transcript paths are resolved from the run's `status.json`.
- View transcript opens with valid TSP nodes; fixed the duplicate `am.meta`
  node id and populated the header/task/output.
- `/subagents-inspect-rpc` replies are handled as a fallback when a transcript
  artifact is not available yet.
- The View transcript action carries the exact agent id instead of relying on
  the clicked child node's id.

## [1.0.18] - 2026-11-09

### Fixed

- `Ctrl+C` now uses a forgiving double-tap exit window: the first press clears
  or aborts and shows `Ctrl+C again to exit`; the second exits. Overlays consume
  Ctrl+C as cancel, and raw pty control bytes are handled before TSP decoding.

## [1.0.17] - 2026-11-09

### Changed

- The compact pi lockup now remains at the top of an active transcript,
  matching omp's welcome lockup retiring into history on the first prompt.
- User bubbles use a softer 18px radius; the brand row and model chip spacing
  were tightened for a quieter active-chat header.

## [1.0.16] - 2026-11-09

### Added

- `/trust` opens a project-trust picker and writes pi's `trust.json` for the
  current working directory. The decision applies on the next pi-tsp launch,
  matching pi's startup trust resolution.

## [1.0.15] - 2026-11-09

### Added

- `/search` transcript search with live match picker, preview and
  `Copy match`; `Ctrl+Shift+F` opens the search prompt when the terminal
  reports that sequence. Search covers user, assistant, tool, agent, bash,
  python, thinking, compaction and branch entries.

## [1.0.14] - 2026-11-09

### Added

- Tree-entry labels in the `/tree` picker: `Label` opens a native input dialog
  and writes through pi's extension-only `setLabel`; labels appear in the tree
  list and branch preview.

## [1.0.13] - 2026-11-09

### Added

- `/settings` now opens a native session settings picker with auto-compaction,
  auto-retry, steering mode, follow-up mode and model/thinking shortcuts. The
  first four map to the pi RPC settings commands.

## [1.0.12] - 2026-11-09

### Added

- In-session tree navigation through the bundled `tsp-tree` extension command,
  using pi's extension-only `ctx.navigateTree()` API. `/tree` now moves the
  active branch and can generate pi's branch summary; `/fork` still creates a
  separate session.

## [1.0.11] - 2026-11-09

### Changed

- `/tree` is now a session-tree picker separate from `/fork`: it restores the
  selected user prompt into the editor instead of immediately creating a new
  session. `/fork` keeps the new-session behavior.

## [1.0.10] - 2026-11-09

### Added

- Provider-aware model logos in the composer and model picker. DeepSeek,
  Z.ai/Zhipu GLM, Anthropic, OpenAI, Google, xAI, Moonshot, Qwen, OpenRouter,
  Groq, Ollama and Mistral aliases resolve to Tern's `provider:<id>` icons;
  unknown providers keep the generic sparkles icon.

## [1.0.9] - 2026-11-09

### Changed

- Quiet the transcript to match omp: removed per-message timestamps and the
  per-turn completion divider; completed thinking is a collapsed
  `Thought for …` line.
- Added the Tern completion notification (`pi` / `Complete`) over OSC 99 when
  a turn settles successfully, matching omp's completion notification.
- Paint the first token immediately and start model, command, stats and
  history discovery in parallel; the render loop remains capped at 16 ms
  (60 fps) and now records TTFT/render timing under `PI_TSP_TRACE`.

## [1.0.8] - 2026-11-09

### Added

- `Alt+Enter` queues a follow-up and `Alt+Up` restores queued messages.
- `--resume` is passed through to pi alongside the other native CLI flags.

## [1.0.7] - 2026-11-09

### Added

- Native shell commands: `!command` adds output to context and `!!command`
  omits it.
- pi RPC extension dialogs for `input` and `editor`, with a native Tern modal
  and keyboard handling.
- Session commands `/new`, `/clone`, `/session`, `/name`, `/thinking`,
  `/export`, `/import`, `/hotkeys`, `/scoped-models`, `/settings`, `/reload`
  and `/changelog`.
- `Ctrl+L` model picker, `Ctrl+R` rename, `Ctrl+X` copy last answer,
  `Shift+Tab` thinking cycle and `Ctrl+D` exit.
- Native extension, skill, prompt-template, theme, tool and context-file flags
  are passed through to pi.

### Changed

- User bubbles now use OMP's 14px Geist typography and keep copy/time meta
  outside the bubble. At the same prompt the bubble is 174 x 41px, versus
  237 x 80px before.

## [1.0.6] - 2026-11-09

### Changed

- Updated the README launch and transcript screenshots from the current build and
  bumped the visible build marker to 1.0.6.

## [1.0.5] - 2026-11-09

### Added

- Pin and unpin sessions in the resume picker; pinned sessions sort first and
  persist in `~/.pi-tsp/pinned.json`.

## [1.0.4] - 2026-11-09

### Added

- `/rename <name>` names the current pi session through the RPC
  `set_session_name` command.

## [1.0.3] - 2026-11-09

### Added

- OMP-style keyboard controls: `Ctrl+O` expands/collapses tool and summary
  output, `Ctrl+T` hides/shows thinking, and `Ctrl+P` cycles models.

## [1.0.2] - 2026-11-09

### Added

- Queued steering and follow-up chips above the composer, with a click to pull
  queued messages back into the editor.
- Session tree/fork picker (`/tree` and `/fork`) backed by pi's `get_tree` and
  `fork` RPC commands.
- Native todo phases from omp-style todo details, including active, done,
  blocked and dropped states.

### Changed

- Composer status now includes per-turn token counts.

## [1.0.1] - 2026-11-09

### Fixed

- The release workflow now configures a Git identity before creating the
  annotated version tag, so a release does not depend on runner defaults.

## [1.0.0] - 2026-11-09

### Added

- Native Tern surface for the pi coding agent over `pi --mode rpc`.
- Semantic transcript: markdown, code, tables, links, math and thinking.
- Tool cards for read, write, edit, bash, grep, find, tests and web tools.
- Diff rendering with hunks and line stats.
- Read grouping for consecutive file reads.
- Bash and Python execution rows with output and exit status.
- Subagent rows with agent name, model, tools, tokens, elapsed time and a
  full transcript modal.
- Custom and hook messages from pi extensions.
- Compaction and branch summary rows.
- Todo checklist with progress and a composer chip.
- Model and thinking-effort pickers backed by pi's RPC state.
- Centered composer with context meter, model/effort chips, working directory
  and send button.
- Slash command menu with live command values.
- Approval sheets for pi permission prompts.
- Plan mode with a native checklist and Implement action.
- Image attachment with composer chips and inline rendering.
- Copy message/answer actions and a copy picker with preview.
- Session resume picker with transcript preview.
- Session deletion from the resume picker with confirmation and current-session
  protection.
- Stock pi fallback outside Tern, in print mode, or with a non-text mode.
- Release workflow: a merged version bump creates a tag, GitHub release and
  installable npm tarball.

### Security

- Isolated `~/.pi-tsp` configuration; the user's `~/.pi` is never modified.
- Config directories are created `0700`; copied model files are `0600`.
- No credentials, model keys, session data or personal paths are stored in the
  repository.

## [Unreleased]

Future changes should add a new version section here before merging. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the release policy.
