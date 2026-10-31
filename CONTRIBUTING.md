# Contributing

## Setup

```bash
bun install
bun run check          # typecheck + tests
bun src/cli.ts status  # run the CLI from source
./macos/build-app.sh   # build the menu bar app into dist/
```

Requirements: macOS 15+, Bun 1.3+, Xcode command line tools.

## Before opening a pull request

- `bun run check` passes, and `swift build --package-path macos` builds.
- Behaviour changes come with a test that calls the code the way a user would and checks literal results (see `test/engine.test.ts`).
- Anything that reads Claude Code or Claude Desktop data on disk is undocumented by Anthropic. Note in the PR which versions you checked it against, and update `docs/architecture.md`.
- Never log or print token values. `cs doctor` and the log only mention which keys exist.
- UI copy is English. Buttons and menu items use title-style capitalization; descriptions use sentence case.

## Layout

See [docs/architecture.md](docs/architecture.md) for the modules and the invariants that keep refresh tokens valid.
