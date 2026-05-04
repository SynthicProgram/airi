# Project AIRI

LLM-powered virtual character platform — an open-source "cyber companion" delivered across desktop (Electron), web, and mobile (Capacitor) surfaces, with shared stage UI, providers, and orchestration modules.

## Tech Stack

- **Languages**: TypeScript (primary), Vue 3, Kotlin & Swift (mobile shells), Rust (legacy `crates/`), Godot/GDScript (`engines/`).
- **Frontend**: Vue 3, Pinia, VueUse, UnoCSS (preferred over Tailwind), reka-ui primitives.
- **3D / Avatar**: Three.js (`stage-ui-three`), Live2D (`stage-ui-live2d`), planned Pixi (`stage-ui-pixi`).
- **Build**: Vite, electron-vite, Capacitor, tsdown (libs), Turbo (monorepo orchestration), pnpm workspaces.
- **Testing / Lint**: Vitest (incl. browser mode), `moeru-lint` (ESLint-based), Knip.
- **Runtime infra**: `@moeru/eventa` (typed IPC/RPC), `injeca` (DI), Valibot (schemas), `@moeru/std` (errors/merging).

## Repository Layout

- [apps/](apps/) — `stage-web`, `stage-tamagotchi` (Electron desktop), `stage-pocket` (Capacitor mobile), `server`, `component-calling`, `ui-server-auth`.
- [packages/](packages/) — shared libraries. Highlights:
  - [packages/stage-ui/](packages/stage-ui/) — core stage components, composables, providers, modules (heart of stage work).
  - [packages/stage-ui-three/](packages/stage-ui-three/), [packages/stage-ui-live2d/](packages/stage-ui-live2d/) — render bindings.
  - [packages/stage-shared/](packages/stage-shared/), [packages/stage-pages/](packages/stage-pages/), [packages/stage-layouts/](packages/stage-layouts/) — cross-surface stage code.
  - [packages/ui/](packages/ui/) — primitives on reka-ui (no business logic).
  - [packages/i18n/](packages/i18n/) — all translations (centralized).
  - [packages/server-runtime/](packages/server-runtime/), [packages/server-sdk/](packages/server-sdk/), [packages/server-shared/](packages/server-shared/), [packages/server-schema/](packages/server-schema/) — server channel powering `services/` and `plugins/`.
  - [packages/core-agent/](packages/core-agent/), [packages/core-character/](packages/core-character/), [packages/memory-pgvector/](packages/memory-pgvector/) — agent + memory.
  - [packages/plugin-sdk/](packages/plugin-sdk/), [packages/plugin-protocol/](packages/plugin-protocol/), [packages/plugin-sdk-tamagotchi/](packages/plugin-sdk-tamagotchi/) — plugin extensibility.
  - [packages/electron-eventa/](packages/electron-eventa/), [packages/electron-screen-capture/](packages/electron-screen-capture/), [packages/electron-vueuse/](packages/electron-vueuse/) — Electron integrations.
- [services/](services/) — bot integrations (Discord, Telegram, Minecraft, Twitter, Satori, computer-use MCP).
- [plugins/](plugins/) — first-party plugins (Bilibili, Claude Code, chess, Home Assistant, web extension).
- [engines/](engines/) — Godot tamagotchi engine.
- [crates/](crates/) — legacy Tauri desktop (Electron is current).
- [docs/](docs/) — public docs site.

## Essential Commands

Use pnpm workspace filters; replace `<pkg>` with package.json `name` (e.g. `@proj-airi/stage-tamagotchi`).

- Install: `pnpm install` (postinstall builds packages).
- Dev: `pnpm dev` (web), `pnpm dev:tamagotchi`, `pnpm dev:server`, `pnpm dev:ui` (Histoire).
- Build: `pnpm -F <pkg> build` or root `pnpm build`.
- Typecheck: `pnpm typecheck` (root) or `pnpm -F <pkg> typecheck`.
- Test: `pnpm test:run` (all), `pnpm exec vitest run <path>` (targeted), `pnpm -F <pkg> exec vitest run`.
- Lint: `pnpm lint` / `pnpm lint:fix` (handles formatting too).
- Always run `pnpm typecheck` and `pnpm lint:fix` after a task.

## Conventions At-a-Glance

- File names: kebab-case. Avoid classes (use FP + `injeca` DI) unless extending runtime/browser APIs.
- Prefer `@moeru/eventa` for any IPC/RPC; centralize contracts (e.g. `apps/stage-tamagotchi/src/shared`).
- Use `errorMessageFrom(error)` from `@moeru/std` for error messages.
- Vue class lists: prefer `:class="['…','…']"` arrays over long inline strings.
- UnoCSS shortcuts in [uno.config.ts](uno.config.ts); reuse animations from [apps/stage-web/src/styles/](apps/stage-web/src/styles/).
- i18n only in [packages/i18n/](packages/i18n/).
- Reproduce bugs with a failing test before patching; tag tests with `Issue #N` / Linear key and link the source report.
- Conventional Commits (`feat:`, `fix:`, …); branches `username/feat/short-name`.

## Additional Documentation

Consult these when the task touches the relevant area:

- [AGENTS.md](AGENTS.md) — full contributor guide (extended conventions, TypeScript regulations, JSDoc/normalizer/regression-test formats, library-selection workflow). Read before any non-trivial change.
- [.claude/docs/architectural_patterns.md](.claude/docs/architectural_patterns.md) — recurring architectural patterns (Eventa IPC, injeca DI, provider/module split in `stage-ui`, server channel layering, scenario components, plugin SDK).
- [docs/ai/context/ui-components.md](docs/ai/context/ui-components.md) — `@proj-airi/ui` component API reference. **Update whenever you add/change components in [packages/ui/](packages/ui/).**
- Per-workspace `README.md` files under [packages/](packages/) and [apps/](apps/) — keep them current (what / how / when to use / when not).
- Histoire stories: [packages/stage-ui/stories/](packages/stage-ui/stories/), [packages/stage-ui/histoire.config.ts](packages/stage-ui/histoire.config.ts) — runnable component examples.
