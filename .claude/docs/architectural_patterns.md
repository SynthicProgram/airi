# Architectural Patterns

Recurring patterns observed across the AIRI monorepo. Follow these when extending existing surfaces; deviate only with reason.

## 1. Typed IPC/RPC via `@moeru/eventa`

All cross-process or cross-runtime communication goes through Eventa, never raw `ipcMain.on` / `postMessage`.

- **Contracts are centralized**, not co-located with senders/receivers, so both sides import the same definition.
  - Desktop contracts: [apps/stage-tamagotchi/src/shared/](apps/stage-tamagotchi/src/shared/).
  - Wiring patterns: [apps/stage-tamagotchi/src/main/services/electron/](apps/stage-tamagotchi/src/main/services/electron/).
  - Electron-specific helpers: [packages/electron-eventa/](packages/electron-eventa/).
- Plugin protocol uses the same approach: [packages/plugin-protocol/](packages/plugin-protocol/), [packages/plugin-sdk/](packages/plugin-sdk/).
- **Why**: type-safe, framework/runtime-agnostic, mockable in Vitest with `vi.fn` instead of a real Electron runtime.

## 2. Functional DI with `injeca`

Composition root assembles services/modules; no class hierarchies.

- Composition example: [apps/stage-tamagotchi/src/main/index.ts](apps/stage-tamagotchi/src/main/index.ts).
- Used for Electron main services, plugins, and frontend service modules.
- **Pattern**: each module exports a factory; `injeca` wires dependencies. Tests pass fake factories instead of monkey-patching.
- Classes appear only when extending browser/runtime APIs (e.g. `EventTarget`, custom elements). Otherwise prefer pure functions returning closures.

## 3. Stage UI: Providers / Modules / Composables / Scenarios

[packages/stage-ui/src/](packages/stage-ui/src/) is layered to keep cross-surface logic shared between web, desktop, and mobile.

- `stores/providers.ts` + `stores/providers/` — **provider definitions** (LLM, TTS, STT, etc.) in a standardized shape. Add new providers here, not inside an app.
- `stores/modules/` — **AIRI orchestration modules** (memory, audio, character state). Combine providers and pure logic.
- `composables/` — **business-oriented Vue helpers**. Reusable across stages; not generic UI helpers.
- `components/` — business components; `components/scenarios/` holds page/use-case-specific assemblies.
- Render bindings live in sibling packages: [packages/stage-ui-three/](packages/stage-ui-three/), [packages/stage-ui-live2d/](packages/stage-ui-live2d/), planned `stage-ui-pixi`.

## 4. UI Primitives vs. Business Components

Strict separation between [packages/ui/](packages/ui/) and [packages/stage-ui/](packages/stage-ui/).

- `packages/ui` wraps **reka-ui** primitives (inputs, textarea, buttons, layout) — no app/business logic. Reference impls under [packages/ui/src/components/Form](packages/ui/src/components/Form).
- All higher-level components compose `@proj-airi/ui` instead of raw DOM elements.
- API surface is documented in [docs/ai/context/ui-components.md](docs/ai/context/ui-components.md) and **must be updated** when components change.

## 5. Server Channel Layering

Server-side runs through three packages so apps, services, and plugins share contracts.

- [packages/server-shared/](packages/server-shared/) — shared types + transport.
- [packages/server-schema/](packages/server-schema/) — Valibot/JSON schemas (provider-compliant: explicit `type: object`, required fields, no unbounded records).
- [packages/server-sdk/](packages/server-sdk/) (+ [packages/server-sdk-shared/](packages/server-sdk-shared/)) — client SDK consumed by [services/](services/) and [plugins/](plugins/).
- [packages/server-runtime/](packages/server-runtime/) — runtime host used by [apps/server/](apps/server/).

## 6. Scenarios as First-Class Artifacts

Long-running visual flows are captured as **scenarios**, runnable headlessly for screenshot/video capture.

- Scenario sources: [packages/scenarios-stage-tamagotchi-electron/src/scenarios/](packages/scenarios-stage-tamagotchi-electron/src/scenarios/), [packages/scenarios-stage-tamagotchi-browser/](packages/scenarios-stage-tamagotchi-browser/).
- Runners: [packages/vishot-runner-electron/](packages/vishot-runner-electron/), [packages/vishot-runner-browser/](packages/vishot-runner-browser/), runtime in [packages/vishot-runtime/](packages/vishot-runtime/).
- Root script `capture:tamagotchi` (in [package.json](package.json)) orchestrates a capture run.

## 7. Schemas with Valibot, Errors with `@moeru/std`

- Validation: Valibot schemas live next to consumers; reuse from `server-schema` when shared.
- Error extraction: always `errorMessageFrom(error)` from `@moeru/std`, paired with `?? 'fallback'` when needed. No manual `error instanceof Error ? error.message : String(error)`.
- Defaults: prefer `@moeru/std` merge utilities + documented default objects over scattered constants.

## 8. Build & Bundling

- Apps and packages built via **Turbo** (`turbo run build -F=…`) for cache-aware orchestration; see [turbo.json](turbo.json).
- Library bundling uses **tsdown**. Reference setup: [packages/vite-plugin-warpdrive/](packages/vite-plugin-warpdrive/).
- Each app has its own Vite/electron-vite config (e.g. [apps/stage-tamagotchi/electron.vite.config.ts](apps/stage-tamagotchi/electron.vite.config.ts), [apps/stage-web/vite.config.ts](apps/stage-web/vite.config.ts)) — router/file-based routing is wired here.

## 9. Settings/Devtools Routing Convention

App pages opt into the settings layout via SFC route blocks:

```vue
<route lang="yaml">
meta:
  layout: settings
</route>
```

Register icons/entries in the per-app settings layout: [apps/stage-tamagotchi/src/renderer/layouts/settings.vue](apps/stage-tamagotchi/src/renderer/layouts/settings.vue), [apps/stage-web/src/layouts/settings.vue](apps/stage-web/src/layouts/settings.vue). Devtools live under each app's `pages/devtools`.

## 10. Plugin Architecture

External capabilities ship as plugins consuming the protocol/SDK rather than patching apps.

- Protocol + SDK: [packages/plugin-protocol/](packages/plugin-protocol/), [packages/plugin-sdk/](packages/plugin-sdk/), tamagotchi-specific surface in [packages/plugin-sdk-tamagotchi/](packages/plugin-sdk-tamagotchi/).
- First-party plugins: [plugins/](plugins/) (Bilibili, Claude Code, chess, Home Assistant, web extension).
- Service-style integrations (bots) live in [services/](services/) and consume the same server SDK.

## 11. Testing Patterns

- Vitest per workspace; root [vitest.config.ts](vitest.config.ts) aggregates projects.
- Mock IPC/services with `vi.fn` / `vi.mock`; never spin up real Electron in unit tests.
- DOM/platform tests prefer **Vitest browser mode** over hard-mocking globals via `Object.defineProperty`.
- For environment-sensitive paths, spawn `node:worker_threads` or a mini CLI rather than mutating `globalThis`.
- Regression tests are tagged with `Issue #N` / Linear key, with the source report linked in a comment above the test and a `// ROOT CAUSE:` block (format in [AGENTS.md](AGENTS.md)).
