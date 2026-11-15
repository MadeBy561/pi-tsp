# Contributing

Thanks for improving pi-tsp. The project is a small, dependency-free Node.js
front end; keep changes focused and verify them against real Tern surfaces where
possible.

## Development

```sh
git clone https://github.com/MadeBy561/pi-tsp.git
cd pi-tsp
npm install
npm test        # builds, then runs the suite
npm link
pi-tsp
```

Requirements: Node 22.19+, pi 1.4+, and Tern 0.9.5+ for the native surface.
Subagent rows require the optional `pi-subagents` pi package
(`pi install npm:pi-subagents`).

## Pull requests

1. Make the change.
2. Bump `version` in `package.json` using Semantic Versioning:
   - patch for fixes and internal changes,
   - minor for new user-visible features,
   - major for breaking changes.
3. Add the same version section to `CHANGELOG.md`.
4. Run `npm test`.
5. Open a PR.

`version-check` fails when a PR does not raise `package.json` above the base
branch. That is intentional: every merged improvement gets a release.

## Releases

Merging a PR with a higher `version` to `main` makes the release workflow:

1. read `package.json`,
2. create the `v<version>` tag if it does not exist,
3. create a GitHub release with the matching changelog section,
4. attach the `npm pack` tarball.

The release tarball can be installed with:

```sh
npm install -g ./pi-tsp-<version>.tgz
```

or installed directly from the repository:

```sh
npm install -g github:MadeBy561/pi-tsp
```

Do not edit a released tag. Cut a new version instead.

## Scope

- `src/launcher.ts` decides between a surface and stock pi; nothing else does.
- `src/model.ts` knows pi's events and nothing about Tern.
- `src/view/*.ts` are pure: conversation plus UI state in, nodes out. They build
  with the Tern SDK's `node()`; the SDK owns ids, diffing, framing and flow control.
- `src/app.ts` owns focus, keys, commands and the RPC session.
- A change to what is drawn needs a test in `test/view.test.mjs` asserting the
  nodes or ops, and a look in Tern.
- To script a session, run `tern serve --control SOCK` and drive it with
  `tern ctl --control SOCK` (`run`, `type`, `key`, `shot`). Scripted sessions
  send Ctrl as Meta; start pi-tsp with `PI_TSP_META_AS_CTRL=1` to reach the
  Ctrl shortcuts, and `PI_TSP_RECORD=file.jsonl` to keep every message.
- Do not add runtime dependencies unless there is a strong reason; the current
  adapter intentionally has none.
- Never commit credentials, model keys, session files or personal paths.

## Testing the surface

The repository tests cover model labels, role handling, todo state, image
rendering and the stock-pi fallback. For a visual check, run `pi-tsp` inside a
Tern agent block and exercise a tool call, subagent, todo list, image attachment,
`/resume`, `/copy`, model/effort pickers and session deletion.
