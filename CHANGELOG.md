# Changelog

All notable changes to pi-tsp are documented here. The project follows
[Semantic Versioning](https://semver.org/).

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
