# Setup Modes

This document explains how to run DoomGen in `cloud`, `local`, or `hybrid` mode.

## Prerequisites

- Node.js + npm
- Repo dependencies installed:

```bash
npm install
cp .env.example .env
```

## Mode: Cloud

Use cloud APIs for planning, image generation, HUD bundle generation, and audio generation.

Required `.env` values:

```bash
VITE_PROVIDER_MODE=cloud
VITE_OPENAI_API_KEY=...
VITE_ELEVENLABS_API_KEY=...
```

Recommended optional values:

```bash
VITE_OPENAI_MODEL=gpt-4.1-mini
VITE_OPENAI_IMAGE_MODEL=gpt-image-1
VITE_ELEVENLABS_BASE_URL=https://api.elevenlabs.io/v1
VITE_ELEVENLABS_VOICE_ID=...
```

Run:

```bash
npm run dev
```

## Mode: Local

Use the local FastAPI service for visual generation. Planner prefers OpenAI when configured; otherwise it falls back to Ollama.

Required `.env` values:

```bash
VITE_PROVIDER_MODE=local
VITE_LOCAL_GEN_BASE_URL=http://127.0.0.1:8000
```

Recommended:

```bash
VITE_LOCAL_ASSET_TIMEOUT_MS=180000
# Optional: prefer OpenAI planner in local mode
VITE_OPENAI_API_KEY=...
VITE_OPENAI_MODEL=gpt-4.1-mini
# Optional: keep provider-backed audio swaps available
VITE_ELEVENLABS_API_KEY=...
```

Start with the one-command launcher (recommended):

```bash
npm run dev:local-mvp
```

Manual option:

1. If no OpenAI key is configured, start Ollama and pull planner model.
2. Start `local-doomgen-service` with `uvicorn`.
3. Run frontend with `npm run dev`.

Current local MVP targets:

- `weapon_sprite_set:pistol`
- `enemy_sprite_set:zombieman`
- `hud_patch_set:doomguy_face`

Audio note:

- `sound_pack:pistol` still uses the provider-backed audio path, so add `VITE_ELEVENLABS_API_KEY` if you want local-mode sound swaps to work.

## Mode: Hybrid

Use both local and cloud providers.

Typical use case:

- local planning/image
- cloud audio or fallback generation

Required `.env` values:

```bash
VITE_PROVIDER_MODE=hybrid
VITE_LOCAL_GEN_BASE_URL=http://127.0.0.1:8000
VITE_OPENAI_API_KEY=...
VITE_ELEVENLABS_API_KEY=...
```

Run local dependencies and frontend:

```bash
npm run dev:local-mvp
```

Current hybrid sweet spot:

- local visuals for `pistol`, `zombieman`, and `doomguy_face`
- cloud audio for `sound_pack:pistol`
- OpenAI planner when available, Ollama otherwise

## Doom WASM Runtime Toggle

If you have built wasm assets and copied them into `public/`, enable:

```bash
VITE_USE_DOOM_WASM=true
VITE_DOOM_WASM_JS_URL=/doom-wasm/websockets-doom.js
VITE_DOOM_WASM_WAD_URL=/doom/doom1.wad
```

## Security Checklist Before Publishing

- Run `npm run prepublish:audit`.
- Confirm no real keys are present in `.env.example` or tracked files.
- Keep `.env` local only.
- Rotate any previously exposed keys.
- Review `git status` and `git diff --cached` before push.
