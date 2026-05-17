# AGENTS.md

Instructions for AI coding agents working in this repository.

## Repository purpose

This is a Pi package monorepo for packages published under the `@codella` npm scope.

## Package naming

- Themes use `pi-theme-*` names:
  - `@codella/pi-theme-cyberpunk`
- Extensions use `pi-*` names without an extra `pi-extension-*` prefix:
  - `@codella/pi-plan-mode`
  - `@codella/pi-mcp-support`

## Layout

```text
packages/
  pi-theme-cyberpunk/
    themes/
  pi-plan-mode/
    extensions/
  pi-mcp-support/
    extensions/
    examples/
```

## Pi package rules

Every publishable package must:

- Include `"keywords": ["pi-package", ...]`.
- Include a `pi` manifest in `package.json`.
- Use a `files` allowlist so tarballs contain only intended package assets.
- Include `README.md` and `LICENSE`.
- Use `publishConfig.access = "public"` for scoped public npm packages.

## Dependencies

- Pi core imports should be `peerDependencies` with a `"*"` range and optional peer metadata.
- Runtime dependencies needed by an extension must be in `dependencies`.
- Do not rely on root `devDependencies` at Pi runtime.

## Validation

Before considering changes complete, run:

```bash
npm run validate
npm run pack:dry-run
```

Or dry-run individual packages:

```bash
npm run pack:theme
npm run pack:plan
npm run pack:mcp
```

Review tarball contents before publishing.

## Local testing before publishing

Test Pi packages locally before publishing.

Load extensions directly for a quick test:

```bash
pi --no-extensions -e ./packages/pi-plan-mode
pi --no-extensions -e ./packages/pi-mcp-support
```

Load a theme directly for a quick test:

```bash
pi --no-themes --theme ./packages/pi-theme-cyberpunk/themes/cyberpunk.json
```

For a more realistic local install, use project settings:

```bash
pi install ./packages/pi-plan-mode -l
pi install ./packages/pi-mcp-support -l
pi install ./packages/pi-theme-cyberpunk -l
```

Remove local test installs when done:

```bash
pi remove ./packages/pi-plan-mode -l
pi remove ./packages/pi-mcp-support -l
pi remove ./packages/pi-theme-cyberpunk -l
```

## Publishing safety

Never run `npm publish` without explicit user approval for the exact package(s) and version(s).

## MCP support

`@codella/pi-mcp-support` documents config in `packages/pi-mcp-support/README.md` and example config in `packages/pi-mcp-support/examples/mcp.json`.

Supported config lookup order:

1. `.pi/mcp.json`
2. `~/.pi/agent/mcp.json`
3. `~/.pi/mcp.json` legacy fallback
