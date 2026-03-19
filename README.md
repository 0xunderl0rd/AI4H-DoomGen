# DoomGen

DoomGen is a prompt-driven DOOM mod prototyping app for cloud and local model workflows. It turns plain-language prompts into live runtime swaps, generated art, and generated audio.

The current app supports three provider modes:

- `cloud`: OpenAI planner + OpenAI image/HUD generation + ElevenLabs audio
- `local`: local FastAPI image/HUD generation, planner prefers OpenAI when configured and falls back to Ollama, audio requests still use the provider-backed path
- `hybrid`: local visual generation with cloud-backed planner and/or audio where useful

The runtime loop is:

1. Prompt -> structured mod plan
2. Plan validation/clamping against allowlisted mutation primitives
3. Immediate runtime mutations on tic boundaries
4. Asynchronous asset generation + hot-swap

## Fastest Path

- Want the least setup: use `cloud`
- Want local visual generation: use `local`
- Want local visuals with cloud-backed audio: use `hybrid`

## Current Scope

Current MVP targets in the shipped code:

- `weapon_sprite_set:pistol`
- `enemy_sprite_set:zombieman`
- `hud_patch_set:doomguy_face`
- `sound_pack:pistol`

Local service scope is intentionally narrower than the frontend abstraction:

- local service handles planning plus local visual asset generation
- sound requests still route through the provider-backed audio path
- Doom WASM runtime is supported when assets are built and enabled

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Then open the local Vite URL shown in terminal.

## Choose A Mode

Detailed setup is in [docs/setup-modes.md](docs/setup-modes.md).

Set one of these in `.env`:

- `VITE_PROVIDER_MODE=cloud`
- `VITE_PROVIDER_MODE=local`
- `VITE_PROVIDER_MODE=hybrid`

High-level env groups:

- Cloud: `VITE_OPENAI_API_KEY`, `VITE_ELEVENLABS_API_KEY`, model IDs
- Local: `VITE_LOCAL_GEN_BASE_URL`, optional `VITE_LOCAL_PLANNER_MODEL`, timeout
- Runtime: `VITE_USE_DOOM_WASM`, wasm/js/wad URLs

## Local Companion Service

Service code lives in `local-doomgen-service/`.

Manual run:

```bash
cd local-doomgen-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Recommended one-command launcher from repo root:

```bash
npm run dev:local-mvp
```

That launcher:

- sets up the local service virtualenv
- starts the FastAPI service
- uses OpenAI planner automatically if a real key is configured
- otherwise falls back to Ollama planner

## Agent Setup Prompt

For Cursor, Claude Code, Codex, or similar agents, use [AGENT_SETUP_PROMPT.md](AGENT_SETUP_PROMPT.md).

It gives the agent a copy/paste brief for:

- choosing `cloud`, `local`, or `hybrid`
- wiring `.env` safely from `.env.example`
- using the repo’s scripts instead of inventing setup steps
- validating setup with audit, typecheck, and build

## Build And Verify

```bash
npm run prepublish:audit
npm run typecheck
npm run build
npm run preview
```

## Runtime Notes

- The app includes a mock engine adapter for fast iteration.
- For playable Doom WASM runtime, build/copy wasm assets with:

```bash
./scripts/build-doom-wasm.sh /path/to/doom1.wad
```

Then set `VITE_USE_DOOM_WASM=true`.

## Security Notes

- Never commit real API keys. Keep secrets in local `.env` only.
- `.env`, local caches, venvs, generated assets, and temp outputs are gitignored.
- If a key may have been exposed, rotate it at the provider immediately.
- Run `npm run prepublish:audit` before public pushes.

Note: `doom-wasm-main/` is vendored third-party upstream source and includes attribution metadata, including maintainer contact emails.
See also: [SECURITY.md](SECURITY.md) for disclosure and key-handling policy.

## Repository Layout

- `src/`: frontend app, planner/runtime adapters, asset pipeline
- `local-doomgen-service/`: local planning and visual generation service
- `public/`: static runtime assets
- `scripts/`: helper scripts for setup, local running, and runtime prep
- `docs/`: mode-specific setup and supporting docs
