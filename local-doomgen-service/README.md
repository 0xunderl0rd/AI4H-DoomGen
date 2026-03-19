# DoomGen Local Service

Companion service for DoomGen `local` and `hybrid` modes.

It provides:

- prompt planning via OpenAI when configured (fallback: Ollama `qwen2.5:1.5b` by default)
- local image generation for selected sprite targets
- alpha extraction/post-processing for generated images

It does not provide audio generation; audio remains on the frontend provider path.

## Supported Local MVP Targets

- `weapon_sprite_set:pistol`
- `enemy_sprite_set:zombieman`
- `hud_patch_set:doomguy_face`

Audio path note:

- `sound_pack:pistol` is supported by the app, but it still uses the provider-backed frontend audio path rather than this service.

## Quick Start

```bash
cd local-doomgen-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Use Python `3.10`-`3.13` (recommended `3.13` on macOS if installed).

If you are not configuring OpenAI planner, start Ollama and pull planner model:

```bash
ollama serve
ollama pull qwen2.5:1.5b
```

Run the service:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Frontend Env Values

```bash
VITE_PROVIDER_MODE=local
VITE_LOCAL_GEN_BASE_URL=http://127.0.0.1:8000
```

For hybrid mode, set `VITE_PROVIDER_MODE=hybrid` and include cloud keys in root `.env`.

## Important Service Env Vars

- `DOOMGEN_OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- `DOOMGEN_OPENAI_API_KEY` (optional; when set, planner uses OpenAI first)
- `DOOMGEN_OPENAI_MODEL` (default `gpt-4.1-mini`)
- `DOOMGEN_IMAGE_MODEL_ID` (default `black-forest-labs/FLUX.2-klein-4B`)
- `DOOMGEN_IMAGE_LORA_ID` (optional)
- `DOOMGEN_IMAGE_STEPS` (default `4`)
- `DOOMGEN_IMAGE_GUIDANCE` (default `1.0`)
- `DOOMGEN_ASSET_DIR` (default `.cache/generated-assets`)
- `DOOMGEN_ASSET_GENERATION_TIMEOUT_SECONDS` (default `180`)
- `DOOMGEN_LOG_LEVEL` (default `INFO`)
