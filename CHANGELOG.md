# Changelog

All notable changes to pi-tsp are documented here. The project follows
[Semantic Versioning](https://semver.org/).

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
