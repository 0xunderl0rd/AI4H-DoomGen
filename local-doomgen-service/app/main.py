from __future__ import annotations

import asyncio
import gc
import io
import json
import logging
import os
import re
import time
import uuid
import wave
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
from pydantic import BaseModel, Field


class PlanRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    model: str | None = None


class AssetRequestPayload(BaseModel):
    kind: str
    target: str
    brief: str
    frameBudget: str | None = None


class GenerateAssetRequest(BaseModel):
    request: AssetRequestPayload
    modId: str


class PullModelRequest(BaseModel):
    model: str


class WarmupRequest(BaseModel):
    components: list[str] | None = None
    keepResident: bool | None = None


class RuntimeState:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.image_pipeline: Any | None = None
        self.sfx_pipeline: Any | None = None
        self.active_image_backend: str = "idle"
        self.active_sfx_backend: str = "idle"
        self.sfx_backend_status: str = "warming"
        self.sfx_backend_error_category: str | None = None
        self.sfx_backend_error_message: str | None = None
        self.sfx_backend_last_probe_at: float = 0.0
        self.keep_models_loaded: bool = str(os.getenv("DOOMGEN_KEEP_MODELS_LOADED", "false")).lower() in {"1", "true", "yes"}
        self.planner_status: str = "idle"
        self.planner_error_message: str | None = None
        self.planner_last_warm_at: float = 0.0


app = FastAPI(title="DoomGen Local Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

state = RuntimeState()

SFX_BACKEND_AUDIO_LDM2 = "audioldm2"
SFX_BACKEND_STABLE_AUDIO = "stable_audio"
DEFAULT_SFX_MODEL_BY_BACKEND = {
    SFX_BACKEND_AUDIO_LDM2: "cvssp/audioldm2-large",
    SFX_BACKEND_STABLE_AUDIO: "stabilityai/stable-audio-open-1.0",
}
DEFAULT_SFX_BACKEND = SFX_BACKEND_STABLE_AUDIO
DEFAULT_STABLE_AUDIO_SCHEDULER = "euler"
SFX_READINESS_STATUS_READY = "ready"
SFX_READINESS_STATUS_WARMING = "warming"
SFX_READINESS_STATUS_BLOCKED = "blocked"
SFX_READINESS_STATUS_ERROR = "error"
SFX_ERROR_CATEGORY_CONFIG = "config"
SFX_ERROR_CATEGORY_MODEL_ACCESS = "model_access"
SFX_ERROR_CATEGORY_BACKEND_INIT = "backend_init"
SFX_ERROR_CATEGORY_RUNTIME = "generation_runtime"
SFX_ERROR_CATEGORY_TIMEOUT = "timeout"
SFX_PROBE_TTL_SECONDS = float(os.getenv("DOOMGEN_SFX_PROBE_TTL_SECONDS", "20"))


def normalize_sfx_backend(raw_value: str | None) -> str:
    value = str(raw_value or "").strip().lower()
    if value in {SFX_BACKEND_AUDIO_LDM2, "audioldm", "audioldm2"}:
        return SFX_BACKEND_AUDIO_LDM2
    if value in {SFX_BACKEND_STABLE_AUDIO, "stableaudio", "stable-audio"}:
        return SFX_BACKEND_STABLE_AUDIO
    return DEFAULT_SFX_BACKEND


def get_huggingface_token() -> str:
    return (os.getenv("HF_TOKEN") or os.getenv("HUGGING_FACE_HUB_TOKEN") or "").strip()


def normalize_stable_audio_scheduler(raw_value: str | None) -> str:
    value = str(raw_value or "").strip().lower().replace("-", "_")
    if value in {"euler", "euler_discrete"}:
        return "euler"
    if value in {"heun", "heun_discrete"}:
        return "heun"
    if value in {"dpm", "dpm_solver", "dpm_solver_multistep", "dpmsolver"}:
        return "dpm_solver_multistep"
    if value in {"edm_dpm", "edm_dpmsolver", "edm_dpmsolver_multistep"}:
        return "edm_dpmsolver_multistep"
    if value in {"edm_euler", "edmeuler"}:
        return "edm_euler"
    return DEFAULT_STABLE_AUDIO_SCHEDULER


OLLAMA_BASE_URL = os.getenv("DOOMGEN_OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("DOOMGEN_OLLAMA_MODEL", "qwen2.5:1.5b").strip()
OPENAI_BASE_URL = (
    os.getenv("DOOMGEN_OPENAI_BASE_URL")
    or os.getenv("OPENAI_BASE_URL")
    or "https://api.openai.com/v1"
).rstrip("/")
OPENAI_API_KEY = (
    os.getenv("DOOMGEN_OPENAI_API_KEY")
    or os.getenv("VITE_OPENAI_API_KEY")
    or os.getenv("OPENAI_API_KEY")
    or ""
).strip()
OPENAI_PLANNER_MODEL = (
    os.getenv("DOOMGEN_OPENAI_MODEL")
    or os.getenv("VITE_OPENAI_MODEL")
    or "gpt-4.1-mini"
).strip()
PREFER_OPENAI_PLANNER = str(os.getenv("DOOMGEN_PREFER_OPENAI_PLANNER", "true")).lower() in {"1", "true", "yes", "on"}
IMAGE_MODEL_ID = os.getenv("DOOMGEN_IMAGE_MODEL_ID", "black-forest-labs/FLUX.2-klein-4B").strip()
IMAGE_LORA_ID = os.getenv("DOOMGEN_IMAGE_LORA_ID", "").strip()
SFX_BACKEND = normalize_sfx_backend(os.getenv("DOOMGEN_SFX_BACKEND", DEFAULT_SFX_BACKEND))
SFX_MODEL_ID = os.getenv(
    "DOOMGEN_SFX_MODEL_ID",
    DEFAULT_SFX_MODEL_BY_BACKEND[SFX_BACKEND],
).strip()
STABLE_AUDIO_SCHEDULER = normalize_stable_audio_scheduler(
    os.getenv(
        "DOOMGEN_STABLE_AUDIO_SCHEDULER",
        DEFAULT_STABLE_AUDIO_SCHEDULER,
    )
)
ASSET_DIR = Path(os.getenv("DOOMGEN_ASSET_DIR", ".cache/generated-assets")).resolve()
ASSET_DIR.mkdir(parents=True, exist_ok=True)

USE_REM_BG = str(os.getenv("DOOMGEN_USE_REMBG", "true")).lower() in {"1", "true", "yes"}
IMAGE_STEPS = int(os.getenv("DOOMGEN_IMAGE_STEPS", "4"))
IMAGE_GUIDANCE_SCALE = float(os.getenv("DOOMGEN_IMAGE_GUIDANCE", "1.0"))
SFX_DURATION_SECONDS = float(os.getenv("DOOMGEN_SFX_DURATION", "4.0"))
HTTP_TIMEOUT_SECONDS = float(os.getenv("DOOMGEN_HTTP_TIMEOUT", "30"))
ASSET_GENERATION_TIMEOUT_SECONDS = float(
    os.getenv("DOOMGEN_ASSET_GENERATION_TIMEOUT_SECONDS", "180")
)
MAX_IMAGE_PROMPT_WORDS = int(os.getenv("DOOMGEN_IMAGE_PROMPT_MAX_WORDS", "72"))
MAX_IMAGE_EDIT_PROMPT_WORDS = int(os.getenv("DOOMGEN_IMAGE_EDIT_PROMPT_MAX_WORDS", "80"))
MAX_AUDIO_PROMPT_WORDS = int(os.getenv("DOOMGEN_AUDIO_PROMPT_MAX_WORDS", "24"))
WRITE_AUDIT_ASSETS = str(os.getenv("DOOMGEN_WRITE_AUDIT_ASSETS", "true")).lower() in {"1", "true", "yes"}

WEAPON_BUNDLE_ROLES = ("ready", "attack", "flash")
WEAPON_BUNDLE_READY_BOUNDS_PADDING = 4
WEAPON_ROLE_MUZZLE_SAMPLE_BAND = 0.22
WEAPON_ROLE_BOUNDS_MAX_RATIO = 1.35
WEAPON_ROLE_BOUNDS_MIN_RATIO = 0.74
WEAPON_ROLE_MUZZLE_DRIFT_PX = 4
WEAPON_SYNTH_FLASH_RADIUS_SCALE = 0.09
WEAPON_SYNTH_FLASH_INNER_RADIUS_SCALE = 0.028
WEAPON_SYNTH_FLASH_CUTOFF_PX = 2
WEAPON_SYNTH_FLASH_ALPHA = 165
WEAPON_SYNTH_FLASH_CORE_SIZE = 10
WEAPON_ROLE_PARITY_DRIFT_MAX = 0.24
WEAPON_ROLE_EDIT_SETTINGS: dict[str, dict[str, float | int]] = {
    "attack": {"steps": 6, "guidance": 1.0, "strength": 0.65},
    "flash": {"steps": 6, "guidance": 1.0, "strength": 0.60},
}
ENEMY_RENDER_BOX = {"width": 96, "height": 112}
ENEMY_RENDER_MARGINS = {"side": 8, "top": 6, "bottom": 4}
ENEMY_TARGET_SPRITE_BOX = {"width": 44, "height": 62}
ENEMY_AUTHORED_ROTATIONS = ("front", "front_right", "right", "back_right", "back")
ENEMY_LIVE_ROTATION_MIRRORS = {
    "front_left": "front_right",
    "left": "right",
    "back_left": "back_right",
}
ZOMBIEMAN_LIVE_FRAME_ROLES = (
    "idle_a",
    "idle_b",
    "run_a",
    "run_b",
    "run_c",
    "run_d",
    "attack_a",
    "attack_b",
    "pain_a",
)
ZOMBIEMAN_DEATH_FRAME_ROLES = ("death_a", "death_b", "death_c", "death_d", "death_e")
ENEMY_ROLE_EDIT_SETTINGS: dict[str, dict[str, float | int]] = {
    "angle": {"steps": 5, "guidance": 1.0, "strength": 0.55},
    "live": {"steps": 5, "guidance": 1.0, "strength": 0.45},
    "death": {"steps": 6, "guidance": 1.0, "strength": 0.62},
}
HUD_FACE_ROLE_SPECS = {
    "neutral": {"size": {"width": 24, "height": 29}},
    "look_left": {"size": {"width": 26, "height": 30}},
    "look_right": {"size": {"width": 26, "height": 30}},
    "pain": {"size": {"width": 24, "height": 31}},
    "evil_grin": {"size": {"width": 24, "height": 30}},
    "dead": {"size": {"width": 24, "height": 31}},
}
HUD_FACE_EDIT_SETTINGS: dict[str, dict[str, float | int]] = {
    "neutral": {"steps": 4, "guidance": 1.0, "strength": 0.0},
    "look_left": {"steps": 5, "guidance": 1.0, "strength": 0.42},
    "look_right": {"steps": 5, "guidance": 1.0, "strength": 0.42},
    "pain": {"steps": 5, "guidance": 1.0, "strength": 0.55},
    "evil_grin": {"steps": 5, "guidance": 1.0, "strength": 0.48},
    "dead": {"steps": 6, "guidance": 1.0, "strength": 0.62},
}

MVP_WEAPON_TARGETS = {"pistol"}
MVP_ENEMY_TARGETS = {"zombieman"}
MVP_SFX_TARGETS = {"pistol"}
MVP_HUD_TARGETS = {"doomguy_face"}
MVP_IMAGE_KINDS = {"weapon_sprite_set", "enemy_sprite_set", "hud_patch_set"}
MVP_AUDIO_KINDS = {"sound_pack"}
SUPPORTED_AUDIO_KINDS = {"sound_pack", "music_track"}

logger = logging.getLogger("doomgen.local")
if not logger.handlers:
    logging.basicConfig(level=os.getenv("DOOMGEN_LOG_LEVEL", "INFO").upper())


PLANNER_SYSTEM_PROMPT = """
You are DoomGen's local mod planner.
Return exactly one JSON object with no markdown.
Use concise, literal asset briefs.
Do not add sound requests unless the prompt explicitly asks for sound/audio/sfx/music/noise/voice.
Treat any reactive clause like "which <sound/action> when shot", "that <phrase> on use", or similar "makes/does/goes/emits/plays ..." behavior as an explicit sound request unless it is clearly visual-only.
For weapon replacement briefs, describe the requested replacement object and any requested style/framing only.
Do not restate original pistol/handgun/gun parts unless the user explicitly asked for a hybrid.

Local MVP constraints:
- weapon_sprite_set target: pistol only
- enemy_sprite_set target: zombieman only
- hud_patch_set target: doomguy_face only
- sound_pack target: pistol only
- music_track is not supported in this local MVP.

Output keys:
- id (string)
- prompt (string)
- title (string)
- summary (string)
- status: "planning"
- families (array)
- assetRequests (array)
- limitations (array, optional)

Asset request shape:
- { "kind": "weapon_sprite_set", "target": "pistol", "brief": "string", "frameBudget": "low" }
- { "kind": "enemy_sprite_set", "target": "zombieman", "brief": "string", "frameBudget": "low" }
- { "kind": "hud_patch_set", "target": "doomguy_face", "brief": "string", "frameBudget": "low" }
- { "kind": "sound_pack", "target": "pistol", "brief": "string" }
""".strip()


@app.get("/v1/health")
async def health() -> dict[str, Any]:
    planner_ok, planner_error, planner_backend, planner_model, planner_resident = await check_planner_health()
    image_ready, image_reason = can_serve_images()
    return {
        "status": "ok" if planner_ok else "degraded",
        "planner": {
            "available": planner_ok,
            "backend": planner_backend,
            "model": planner_model,
            "error": planner_error,
            "status": state.planner_status,
            "resident": planner_resident,
        },
        "image": {
            "available": image_ready,
            "backend": state.active_image_backend,
            "model": IMAGE_MODEL_ID,
            "error": image_reason,
            "resident": state.image_pipeline is not None,
        },
        "sfx": {
            "available": False,
            "status": "disabled",
            "errorCategory": "provider_routed",
            "configuredBackend": "elevenlabs_provider",
            "backend": "elevenlabs_provider",
            "model": None,
            "error": "Local SFX generation is disabled; sound packs use the ElevenLabs provider path.",
            "resident": False,
        },
        "warmup": {
            "keepResident": state.keep_models_loaded,
        },
    }


@app.get("/v1/capabilities")
async def capabilities() -> dict[str, Any]:
    planner_ok, planner_error, planner_backend, planner_model, _ = await check_planner_health()
    image_ready, image_reason = can_serve_images()
    return {
        "plannerAvailable": planner_ok,
        "plannerBackend": planner_backend,
        "plannerModel": planner_model,
        "weaponImageAvailable": image_ready,
        "enemyImageAvailable": image_ready,
        "sfxAvailable": False,
        "sfxStatus": "disabled",
        "sfxErrorCategory": "provider_routed",
        "sfxError": "Local SFX generation is disabled; sound packs use the ElevenLabs provider path.",
        "configuredSfxBackend": "elevenlabs_provider",
        "configuredSfxModel": None,
        "keepModelsLoaded": state.keep_models_loaded,
        "musicAvailable": False,
        "supportedAssetRequests": [
            {"kind": "weapon_sprite_set", "targets": sorted(MVP_WEAPON_TARGETS)},
            {"kind": "enemy_sprite_set", "targets": sorted(MVP_ENEMY_TARGETS)},
            {"kind": "hud_patch_set", "targets": sorted(MVP_HUD_TARGETS)},
        ],
        "activeImageBackend": state.active_image_backend,
        "activeSfxBackend": "elevenlabs_provider",
        "errors": dedupe_messages([planner_error, image_reason]),
    }


@app.post("/v1/models/pull")
async def pull_model(payload: PullModelRequest) -> dict[str, Any]:
    model = payload.model.strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{OLLAMA_BASE_URL}/api/pull",
            json={"model": model, "stream": False},
        )
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Ollama model pull failed ({response.status_code}): {response.text[:220]}",
        )
    return {"ok": True, "model": model}


@app.post("/v1/warmup")
async def warmup_models(payload: WarmupRequest) -> dict[str, Any]:
    requested_components = payload.components or ["planner", "image"]
    normalized_components: list[str] = []
    for component in requested_components:
        value = str(component or "").strip().lower()
        if value in {"planner", "image"} and value not in normalized_components:
            normalized_components.append(value)
    if not normalized_components:
        raise HTTPException(status_code=400, detail="components must include at least one of: planner, image")

    if payload.keepResident is not None:
        state.keep_models_loaded = bool(payload.keepResident)

    results: dict[str, dict[str, Any]] = {}

    for component in normalized_components:
        started_at = time.monotonic()
        try:
            if component == "planner":
                await warm_planner_model(OLLAMA_MODEL)
                planner_backend = resolve_planner_backend(OLLAMA_MODEL)
                planner_model = OPENAI_PLANNER_MODEL if planner_backend == "openai" else OLLAMA_MODEL
                results[component] = {
                    "ok": True,
                    "status": state.planner_status,
                    "backend": planner_backend,
                    "model": planner_model,
                    "elapsedSeconds": round(time.monotonic() - started_at, 2),
                }
            elif component == "image":
                await ensure_image_pipeline()
                results[component] = {
                    "ok": True,
                    "status": "ready",
                    "backend": state.active_image_backend,
                    "model": IMAGE_MODEL_ID,
                    "resident": state.image_pipeline is not None,
                    "elapsedSeconds": round(time.monotonic() - started_at, 2),
                }
        except Exception as exc:
            results[component] = {
                "ok": False,
                "status": "error",
                "message": str(exc) if str(exc) else exc.__class__.__name__,
                "elapsedSeconds": round(time.monotonic() - started_at, 2),
            }

    overall_ok = all(result.get("ok") for result in results.values())
    return {
        "ok": overall_ok,
        "keepResident": state.keep_models_loaded,
        "results": results,
    }


@app.post("/v1/plan")
async def plan(payload: PlanRequest) -> dict[str, Any]:
    planner_backend = resolve_planner_backend(payload.model)
    normalized_plan = await run_planner(payload.prompt, payload.model, planner_backend)
    if normalized_plan["assetRequests"] == []:
        normalized_plan["limitations"] = dedupe_messages(
            [
                *(normalized_plan.get("limitations", []) or []),
                "Local planner produced no supported local MVP asset requests.",
            ]
        )

    return {"plan": normalized_plan}


@app.post("/v1/generate/asset")
async def generate_asset(payload: GenerateAssetRequest, request: Request) -> dict[str, Any]:
    req = payload.request
    kind = req.kind.strip()
    target = req.target.strip()
    brief = req.brief.strip()
    if not kind or not target or not brief:
        raise HTTPException(status_code=400, detail="request.kind, request.target, and request.brief are required")

    if not is_supported_local_asset_request(kind, target):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unsupported local MVP asset request: {kind}:{target}. "
                "Supported: weapon_sprite_set:pistol, enemy_sprite_set:zombieman, hud_patch_set:doomguy_face."
            ),
        )

    handle = build_handle(kind, target, payload.modId)
    started_at = time.monotonic()
    timeout_seconds = get_asset_generation_timeout_seconds(kind, target)
    logger.info(
        "asset.generate.start kind=%s target=%s modId=%s handle=%s timeout=%.1fs",
        kind,
        target,
        payload.modId,
        handle,
        timeout_seconds,
    )

    try:
        if is_image_kind(kind):
            image_result = await asyncio.wait_for(
                generate_image_asset(handle, kind, target, brief, req.frameBudget),
                timeout=timeout_seconds,
            )
            media_type = "image/png"
            source = "local"
        elif is_audio_kind(kind):
            raise HTTPException(
                status_code=422,
                detail="Local audio generation is disabled; sound packs use the ElevenLabs provider path.",
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported asset kind: {kind}")
    except asyncio.TimeoutError as timeout_error:
        elapsed = time.monotonic() - started_at
        message = (
            f"{kind}:{target} asset generation timed out after {elapsed:.1f}s."
            "This usually means model warmup/download is still in progress or backend initialization stalled."
        )
        logger.error("asset.generate.timeout kind=%s target=%s modId=%s elapsed=%.2fs", kind, target, payload.modId, elapsed)
        raise HTTPException(
            status_code=503,
            detail={
                "code": "asset_generation_timeout",
                "category": SFX_ERROR_CATEGORY_TIMEOUT,
                "backend": IMAGE_BACKEND,
                "model": IMAGE_MODEL_ID,
                "message": message[:500],
            },
        ) from timeout_error
    except HTTPException as http_error:
        elapsed = time.monotonic() - started_at
        logger.error(
            "asset.generate.http_error kind=%s target=%s modId=%s elapsed=%.2fs status=%s detail=%s",
            kind,
            target,
            payload.modId,
            elapsed,
            http_error.status_code,
            http_error.detail,
        )
        raise
    except Exception as error:
        elapsed = time.monotonic() - started_at
        if is_audio_kind(kind):
            category, message = classify_sfx_error(error)
            logger.exception(
                "asset.generate.error kind=%s target=%s modId=%s elapsed=%.2fs category=%s detail=%s",
                kind,
                target,
                payload.modId,
                elapsed,
                category,
                message,
            )
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "sfx_backend_unavailable",
                    "category": category,
                    "backend": SFX_BACKEND,
                    "model": SFX_MODEL_ID,
                    "message": message[:500],
                },
            ) from error
        logger.exception(
            "asset.generate.error kind=%s target=%s modId=%s elapsed=%.2fs",
            kind,
            target,
            payload.modId,
            elapsed,
        )
        raise HTTPException(status_code=500, detail=f"Asset generation failed for {kind}:{target}: {error}") from error

    if is_image_kind(kind):
        primary_path = image_result["primary_path"]
        asset_url = str(request.url_for("get_asset", asset_name=primary_path.name))
    else:
        asset_url = str(request.url_for("get_asset", asset_name=asset_path.name))
    elapsed = time.monotonic() - started_at
    logger.info(
        "asset.generate.ok kind=%s target=%s modId=%s handle=%s elapsed=%.2fs path=%s",
        kind,
        target,
        payload.modId,
        handle,
        elapsed,
        primary_path.name if is_image_kind(kind) else asset_path.name,
    )
    response_payload: dict[str, Any] = {
        "handle": handle,
        "mediaType": media_type,
        "assetUrl": asset_url,
        "playbackUrl": asset_url,
        "brief": brief,
        "source": source,
        "createdAt": now_iso(),
    }
    if is_image_kind(kind):
        if image_result.get("warnings"):
            response_payload["warnings"] = image_result["warnings"]
        if image_result.get("bundle"):
            response_payload["bundle"] = serialize_image_bundle_response(image_result["bundle"], request)
    return response_payload


@app.get("/v1/assets/{asset_name}", name="get_asset")
async def get_asset(asset_name: str) -> FileResponse:
    safe_name = Path(asset_name).name
    path = ASSET_DIR / safe_name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")

    if path.suffix.lower() == ".png":
        media_type = "image/png"
    elif path.suffix.lower() == ".wav":
        media_type = "audio/wav"
    else:
        media_type = "application/octet-stream"
    return FileResponse(path, media_type=media_type)


async def generate_image_asset(
    handle: str,
    kind: str,
    target: str,
    brief: str,
    frame_budget: str | None = None,
) -> dict[str, Any]:
    image_ready, reason = can_serve_images()
    if not image_ready:
        raise HTTPException(status_code=503, detail=f"Image backend unavailable: {reason}")

    if kind == "weapon_sprite_set" and target == "pistol":
        return await generate_pistol_weapon_bundle(handle, brief, frame_budget)
    if kind == "enemy_sprite_set" and target == "zombieman":
        return await generate_zombieman_enemy_bundle(handle, brief, frame_budget)
    if kind == "hud_patch_set" and target == "doomguy_face":
        return await generate_doomguy_face_bundle(handle, brief, frame_budget)

    prompt = build_image_prompt(kind, target, brief)
    logger.info("image.prompt kind=%s target=%s prompt=%s", kind, target, prompt)

    async with state.lock:
        await ensure_image_pipeline()
        image = await run_image_generation(prompt)

    raw_path = ASSET_DIR / f"{handle}.raw.png"
    processed_path = ASSET_DIR / f"{handle}.processed.png"
    audit_path = ASSET_DIR / f"{handle}.audit.json"

    if WRITE_AUDIT_ASSETS:
        image.save(raw_path, format="PNG")

    if USE_REM_BG:
        image = try_remove_background(image)

    if WRITE_AUDIT_ASSETS:
        image.save(processed_path, format="PNG")
        write_asset_audit(
            audit_path,
            {
                "handle": handle,
                "kind": kind,
                "target": target,
                "brief": brief,
                "visualConcept": extract_visual_concept(brief),
                "imagePrompt": prompt,
                "rawImagePath": raw_path.name,
                "processedImagePath": processed_path.name,
                "finalImagePath": f"{handle}.png",
            },
        )

    out_path = ASSET_DIR / f"{handle}.png"
    image.save(out_path, format="PNG")
    return {
        "primary_path": out_path,
        "warnings": [],
        "bundle": None,
    }


async def generate_audio_asset(
    handle: str,
    profile: dict[str, Any],
    brief: str,
) -> Path:
    sfx_ready, reason, category = await can_serve_sfx()
    if not sfx_ready:
        status = category or SFX_ERROR_CATEGORY_CONFIG
        raise HTTPException(
            status_code=503,
            detail={
                "code": "sfx_backend_unavailable",
                "category": status,
                "backend": SFX_BACKEND,
                "model": SFX_MODEL_ID,
                "message": f"SFX backend unavailable: {reason}",
            },
        )

    kind = profile["kind"]
    prompt = profile["prompt_builder"](brief)
    logger.info(
        "audio.prompt kind=%s target=%s duration=%.2fs prompt=%s",
        kind,
        profile["target_hint"],
        profile["duration_seconds"],
        prompt,
    )
    out_path = ASSET_DIR / f"{handle}.wav"

    try:
        async with state.lock:
            raw_samples, sample_rate = await run_sfx_generation(prompt, profile["duration_seconds"], kind)
    except Exception as exc:
        category, message = classify_sfx_error(exc)
        logger.error(
            "sfx.generation.failed category=%s backend=%s model=%s kind=%s target=%s detail=%s",
            category,
            SFX_BACKEND,
            SFX_MODEL_ID,
            kind,
            profile["target_hint"],
            message,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "sfx_backend_unavailable",
                "category": category,
                "backend": SFX_BACKEND,
                "model": SFX_MODEL_ID,
                "message": message[:500],
            },
        ) from exc

    normalized = normalize_audio(raw_samples, sample_rate, profile)
    write_wav_pcm16(out_path, sample_rate, normalized)
    return out_path


def get_asset_generation_timeout_seconds(kind: str, target: str) -> float:
    if kind == "enemy_sprite_set" and target == "zombieman":
        return max(ASSET_GENERATION_TIMEOUT_SECONDS, 600.0)
    if kind == "hud_patch_set" and target == "doomguy_face":
        return max(ASSET_GENERATION_TIMEOUT_SECONDS, 420.0)
    return ASSET_GENERATION_TIMEOUT_SECONDS


def serialize_image_bundle_response(bundle: dict[str, Any], request: Request) -> dict[str, Any]:
    roles_payload: dict[str, Any] = {}
    for role, role_data in bundle.get("roles", {}).items():
        path = role_data.get("path")
        if not isinstance(path, Path):
            continue
        role_payload: dict[str, Any] = {
            "assetUrl": str(request.url_for("get_asset", asset_name=path.name)),
            "mediaType": role_data.get("media_type", "image/png"),
        }
        preview_path = role_data.get("preview_path")
        if isinstance(preview_path, Path):
            role_payload["previewUrl"] = str(request.url_for("get_asset", asset_name=preview_path.name))
        derived_from = role_data.get("derived_from")
        if isinstance(derived_from, str) and derived_from:
            role_payload["derivedFrom"] = derived_from
        theme_effect = role_data.get("theme_effect")
        if isinstance(theme_effect, str) and theme_effect:
            role_payload["themeEffect"] = theme_effect
        role_metadata = role_data.get("metadata")
        if isinstance(role_metadata, dict) and role_metadata:
            role_payload["metadata"] = role_metadata
        roles_payload[role] = role_payload

    response_payload: dict[str, Any] = {
        "kind": bundle.get("kind", "weapon_sprite_bundle"),
        "roles": roles_payload,
    }
    metadata = bundle.get("metadata")
    if isinstance(metadata, dict) and metadata:
        response_payload["metadata"] = metadata
    return response_payload


def normalize_weapon_bundle_mode(frame_budget: str | None, supports_edits: bool) -> str:
    if not supports_edits:
        return "ready_only"
    budget = (frame_budget or "").strip().lower()
    if budget in {"low", "low_quality", "fast", "limited"}:
        return "ready_attack"
    if budget in {"high", "full", "quality", "best"}:
        return "full"
    if budget in {"attack_only", "attack-only", "ready_attack"}:
        return "ready_attack"
    if budget in {"ready_only", "ready-only"}:
        return "ready_only"
    return "ready_attack"


def estimate_muzzle_point(data: np.ndarray, bounds: tuple[int, int, int, int]) -> tuple[int, int]:
    x0, y0, x1, y1 = bounds
    alpha = data[:, :, 3]
    ys, xs = np.where(alpha >= 56)
    if ys.size == 0 or xs.size == 0:
        center_x = x0 + (x1 - x0) // 2
        center_y = y0 + (y1 - y0) // 2
        return center_x, center_y

    bounds_mask = (xs >= x0) & (xs <= x1) & (ys >= y0) & (ys <= y1)
    cx = xs[bounds_mask]
    cy = ys[bounds_mask]
    if cx.size == 0 or cy.size == 0:
        center_x = x0 + (x1 - x0) // 2
        center_y = y0 + (y1 - y0) // 2
        return center_x, center_y

    width = max(1, x1 - x0 + 1)
    height = max(1, y1 - y0 + 1)
    band_width = max(4, int(width * WEAPON_ROLE_MUZZLE_SAMPLE_BAND))
    upper_band_height = max(4, int(height * 0.42))
    muzzle_x_threshold = max(x0, x1 - band_width)
    upper_band_limit = min(y1, y0 + upper_band_height)
    muzzle_mask = (cx >= muzzle_x_threshold) & (cy <= upper_band_limit)
    muzzle_xs = cx[muzzle_mask]
    muzzle_ys = cy[muzzle_mask]
    if muzzle_xs.size == 0:
        muzzle_mask = cx >= muzzle_x_threshold
        muzzle_xs = cx[muzzle_mask]
        muzzle_ys = cy[muzzle_mask]
    if muzzle_xs.size == 0:
        muzzle_xs = cx
        muzzle_ys = cy

    return int(np.mean(muzzle_xs)), int(np.mean(muzzle_ys))


def build_weapon_template_profile(image: Image.Image) -> dict[str, Any]:
    rgba = image.convert("RGBA")
    bounds = find_nontransparent_bounds(rgba)
    if bounds is None:
        bounds = (0, 0, image.width - 1, image.height - 1)
    x0, y0, x1, y1 = bounds
    data = np.array(rgba, dtype=np.uint8)
    muzzle_x, muzzle_y = estimate_muzzle_point(data, bounds)
    source_bounds = {
        "x": x0,
        "y": y0,
        "width": max(1, x1 - x0 + 1),
        "height": max(1, y1 - y0 + 1),
    }
    return {
        "sourceBounds": source_bounds,
        "muzzlePoint": {"x": muzzle_x, "y": muzzle_y},
        "barrelAxis": {
            "angleDegrees": 0.0,
            "length": max(1, source_bounds["width"] // 5),
            "centerX": muzzle_x,
            "centerY": muzzle_y,
        },
        "sourceCanvas": {"width": image.width, "height": image.height},
    }


def build_weapon_role_signature(image: Image.Image) -> dict[str, float]:
    sample = image.convert("RGBA").resize((48, 48), Image.Resampling.BILINEAR)
    data = np.array(sample, dtype=np.float32)
    alpha = data[:, :, 3] / 255.0
    luminance = (
        0.299 * data[:, :, 0] + 0.587 * data[:, :, 1] + 0.114 * data[:, :, 2]
    ) / 255.0
    weighted = luminance * alpha
    edge_x = np.abs(np.diff(weighted, axis=1))
    edge_y = np.abs(np.diff(weighted, axis=0))
    edge_density = float((edge_x.mean() + edge_y.mean()) / 2.0)
    return {
        "coverage": float(alpha.mean()),
        "edgeDensity": edge_density,
        "lumaMean": float(weighted.mean()),
    }


def compare_weapon_signatures(a: dict[str, float], b: dict[str, float]) -> float:
    coverage_delta = abs(a.get("coverage", 0.0) - b.get("coverage", 0.0))
    edge_delta = abs(a.get("edgeDensity", 0.0) - b.get("edgeDensity", 0.0))
    luma_delta = abs(a.get("lumaMean", 0.0) - b.get("lumaMean", 0.0))
    return coverage_delta + edge_delta + luma_delta


def build_ready_fallback_attack(image: Image.Image) -> Image.Image:
    source_rgba = image.convert("RGBA")
    width, height = source_rgba.size
    shifted = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    shifted.alpha_composite(source_rgba, (2, -8))
    output = Image.blend(source_rgba, shifted, 0.4)
    output = ImageEnhance.Brightness(output).enhance(1.08)
    output = ImageEnhance.Contrast(output).enhance(1.08)
    return output


def build_synthetic_flash_from_template(image: Image.Image, template: dict[str, Any]) -> Image.Image:
    source_rgba = image.convert("RGBA")
    muzzle = template.get("muzzlePoint", {})
    muzzle_x = int(muzzle.get("x", source_rgba.width // 2))
    muzzle_y = int(muzzle.get("y", source_rgba.height // 3))
    width, height = source_rgba.width, source_rgba.height
    glow_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    drawer = ImageDraw.Draw(glow_layer)
    core = max(WEAPON_SYNTH_FLASH_CORE_SIZE, int(min(width, height) * WEAPON_SYNTH_FLASH_INNER_RADIUS_SCALE))
    outer = max(core, int(min(width, height) * WEAPON_SYNTH_FLASH_RADIUS_SCALE))

    for index in (0, 1, 2, 3, 4):
        radius = outer + (index * 6)
        alpha = max(0, WEAPON_SYNTH_FLASH_ALPHA + 24 - index * 24)
        drawer.ellipse(
            (muzzle_x - radius, muzzle_y - radius, muzzle_x + radius, muzzle_y + radius),
            fill=(255, 212, 96, alpha),
        )
    burst_length = max(core * 3, int(min(width, height) * 0.16))
    burst_half = max(4, core // 2)
    drawer.polygon(
        [
            (muzzle_x - burst_half, muzzle_y - burst_half),
            (muzzle_x + burst_length, muzzle_y),
            (muzzle_x - burst_half, muzzle_y + burst_half),
        ],
        fill=(255, 228, 140, min(255, WEAPON_SYNTH_FLASH_ALPHA + 32)),
    )
    for index in (0, 1, 2):
        radius = core + index * 5
        drawer.ellipse(
            (muzzle_x - radius, muzzle_y - radius, muzzle_x + radius, muzzle_y + radius),
            outline=(255, 246, 214, 110 - index * 18),
            width=1,
        )

    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=1.8))
    return postprocess_flash_overlay(glow_layer)


def is_role_geometry_aligned(
    role_template: dict[str, Any],
    ready_template: dict[str, Any],
    role: str,
    ready_signature: dict[str, float] | None = None,
    role_signature: dict[str, float] | None = None,
) -> tuple[bool, dict[str, float]]:
    ready_bounds = ready_template.get("sourceBounds", {})
    role_bounds = role_template.get("sourceBounds", {})
    ready_w = float(ready_bounds.get("width", 1) or 1)
    ready_h = float(ready_bounds.get("height", 1) or 1)
    role_w = float(role_bounds.get("width", 1) or 1)
    role_h = float(role_bounds.get("height", 1) or 1)
    ready_muzzle = ready_template.get("muzzlePoint", {})
    role_muzzle = role_template.get("muzzlePoint", {})
    muzzle_delta_x = abs(float(role_muzzle.get("x", ready_muzzle.get("x", 0))) - float(ready_muzzle.get("x", 0)))
    muzzle_delta_y = abs(float(role_muzzle.get("y", ready_muzzle.get("y", 0))) - float(ready_muzzle.get("y", 0)))
    rel_muzzle_dx = muzzle_delta_x / max(1.0, ready_w)
    rel_muzzle_dy = muzzle_delta_y / max(1.0, ready_h)

    size_ratio_w = role_w / ready_w
    size_ratio_h = role_h / ready_h
    max_ratio = max(size_ratio_w, 1.0 / size_ratio_w, size_ratio_h, 1.0 / size_ratio_h)
    min_ratio = min(size_ratio_w, 1.0 / size_ratio_w, size_ratio_h, 1.0 / size_ratio_h)

    allowed_ratio = WEAPON_ROLE_BOUNDS_MAX_RATIO * (1.2 if role == "flash" else 1.0)
    max_muzzle_px = WEAPON_ROLE_MUZZLE_DRIFT_PX * (2 if role == "flash" else 1)

    failure_reasons: list[str] = []
    if max_ratio > allowed_ratio:
        failure_reasons.append("identity")
    if min_ratio < WEAPON_ROLE_BOUNDS_MIN_RATIO:
        failure_reasons.append("identity")
    if muzzle_delta_x > max_muzzle_px or muzzle_delta_y > max_muzzle_px:
        failure_reasons.append("anchor")

    signature_delta = None
    if role != "flash" and ready_signature is not None and role_signature is not None:
        signature_delta = compare_weapon_signatures(ready_signature, role_signature)
        if signature_delta > WEAPON_ROLE_PARITY_DRIFT_MAX:
            failure_reasons.append("identity")

    if failure_reasons:
        metrics = {
            "sizeRatio": max_ratio,
            "sizeRatioMin": min_ratio,
            "muzzleDx": rel_muzzle_dx,
            "muzzleDy": rel_muzzle_dy,
            "muzzleDeltaPx": max(muzzle_delta_x, muzzle_delta_y),
            "signatureDelta": signature_delta,
        }
        if "anchor" in failure_reasons:
            metrics["anchorDriftPx"] = float(max(muzzle_delta_x, muzzle_delta_y))
        if "identity" in failure_reasons:
            metrics["identityDrift"] = 1.0
        return False, metrics

    return True, {
        "sizeRatio": max_ratio,
        "sizeRatioMin": min_ratio,
        "muzzleDx": rel_muzzle_dx,
        "muzzleDy": rel_muzzle_dy,
        "muzzleDeltaPx": max(muzzle_delta_x, muzzle_delta_y),
        "signatureDelta": signature_delta,
    }


async def generate_pistol_weapon_bundle(
    handle: str,
    brief: str,
    frame_budget: str | None = None,
) -> dict[str, Any]:
    bundle_spec = build_pistol_weapon_bundle_spec(brief)
    logger.info(
        "image.bundle.start target=pistol handle=%s replacementMode=%s handMode=%s styleMode=%s",
        handle,
        bundle_spec["replacement_mode"],
        bundle_spec["hand_mode"],
        bundle_spec["style_mode"],
    )
    logger.info("image.bundle.prompt role=ready target=pistol prompt=%s", bundle_spec["prompts"]["ready"])

    warnings: list[str] = []
    async with state.lock:
        await ensure_image_pipeline()
        ready_raw = await run_image_generation(bundle_spec["prompts"]["ready"])
        ready_processed = try_remove_background(ready_raw)
        ready_template = build_weapon_template_profile(ready_processed)
        ready_signature = build_weapon_role_signature(ready_processed)
        shared_anchor = build_shared_weapon_anchor(
            ready_processed,
            "pistol",
            weapon_template=ready_template,
        )
        role_outputs: dict[str, dict[str, Any]] = {
            "ready": save_weapon_bundle_role_artifacts(
                handle,
                "ready",
                ready_raw,
                ready_processed,
                None,
                "pistol",
                shared_anchor,
            )
        }

        supports_edits, edit_reason = get_local_weapon_bundle_edit_support("pistol")
        bundle_mode = normalize_weapon_bundle_mode(frame_budget, supports_edits)
        if bundle_mode == "ready_only":
            warning = (
                "Local pistol bundle generation mode selected READY fallback only for budget constraints; "
                f"attack and flash will be derived from READY geometry."
            )
            warnings.append(warning)
            logger.info("image.bundle.mode target=pistol handle=%s mode=%s", handle, bundle_mode)

        if supports_edits and bundle_mode in {"ready_attack", "full"}:
            logger.info(
                "image.bundle.edit_support target=pistol supported=true backend=%s mode=%s",
                edit_reason,
                bundle_mode,
            )
            generate_roles = ["attack"] if bundle_mode == "ready_attack" else ["attack", "flash"]
            for role in generate_roles:
                role_prompt = bundle_spec["prompts"][role]
                role_settings = WEAPON_ROLE_EDIT_SETTINGS[role]
                logger.info(
                    "image.bundle.prompt role=%s target=pistol prompt=%s steps=%s guidance=%s strength=%s",
                    role,
                    role_prompt,
                    role_settings["steps"],
                    role_settings["guidance"],
                    role_settings["strength"],
                )
                try:
                    role_raw = await run_image_generation(
                        role_prompt,
                        source_image=ready_processed,
                        steps_override=int(role_settings["steps"]),
                        guidance_override=float(role_settings["guidance"]),
                        strength_override=float(role_settings["strength"]),
                    )
                    role_processed = try_remove_background(role_raw)
                    if role == "attack":
                        role_processed = apply_edit_strength_blend(
                            ready_processed,
                            role_processed,
                            float(role_settings["strength"]),
                        )
                    else:
                        role_processed = isolate_flash_emission_overlay(
                            ready_processed,
                            role_processed,
                        )
                        if not has_meaningful_flash_overlay(role_processed):
                            raise RuntimeError("flash cleanup removed nearly all emission pixels")

                    role_template = build_weapon_template_profile(role_processed)
                    role_signature = build_weapon_role_signature(role_processed)
                    aligned, metrics = is_role_geometry_aligned(
                        role_template,
                        ready_template,
                        role,
                        ready_signature=ready_signature,
                        role_signature=role_signature,
                    )
                    if not aligned:
                        drift_type = []
                        if metrics.get("identityDrift"):
                            drift_type.append("identity drift")
                        if metrics.get("anchorDriftPx"):
                            drift_type.append("anchor drift")
                        if not drift_type:
                            drift_type.append("parity drift")
                        raise RuntimeError(
                            f"{role.upper()} role failed {'/'.join(drift_type)} gates: "
                            f"sizeRatio={metrics.get('sizeRatio', 'n/a')} "
                            f"muzzleDx={metrics.get('muzzleDx', 'n/a')} "
                            f"muzzleDy={metrics.get('muzzleDy', 'n/a')}"
                        )

                    role_outputs[role] = save_weapon_bundle_role_artifacts(
                        handle,
                        role,
                        role_raw,
                        role_processed,
                        "ready",
                        "pistol",
                        shared_anchor,
                    )
                except Exception as role_error:
                    message = str(role_error) if str(role_error) else role_error.__class__.__name__
                    warning = (
                        f"Generated pistol {role.upper()} role failed: {message}. "
                        "Falling back to READY-derived role asset."
                    )
                    warnings.append(warning)
                    logger.warning("image.bundle.partial target=pistol role=%s reason=%s", role, warning)
                    fallback = (
                        build_ready_fallback_attack(ready_processed) if role == "attack"
                        else build_synthetic_flash_from_template(ready_processed, ready_template)
                    )
                    role_outputs[role] = save_weapon_bundle_role_artifacts(
                        handle,
                        role,
                        ready_raw,
                        fallback,
                        "ready",
                        "pistol",
                        shared_anchor,
                    )

        for role in ("attack", "flash"):
            if role in role_outputs:
                continue
            fallback = (
                build_ready_fallback_attack(ready_processed) if role == "attack"
                else build_synthetic_flash_from_template(ready_processed, ready_template)
            )
            warning = f"Local pistol bundle missing {role.upper()} role; using READY geometry-derived fallback."
            warnings.append(warning)
            role_outputs[role] = save_weapon_bundle_role_artifacts(
                handle,
                role,
                ready_raw,
                fallback,
                "ready",
                "pistol",
                shared_anchor,
            )
            logger.warning("image.bundle.partial target=pistol role=%s reason=%s", role, warning)

        if not supports_edits:
            warning = (
                "Local pistol bundle generated READY plus deterministic ATTACK/FLASH fallback assets; "
                f"edit/reference derivation is not available for backend {edit_reason}."
            )
            warnings.append(warning)
            logger.warning("image.bundle.partial target=pistol reason=%s", warning)

    audit_payload = {
        "handle": handle,
        "kind": "weapon_sprite_set",
        "target": "pistol",
        "brief": brief,
        "visualConcept": bundle_spec["visual_concept"],
        "replacementMode": bundle_spec["replacement_mode"],
        "handMode": bundle_spec["hand_mode"],
        "styleMode": bundle_spec["style_mode"],
        "themeEffect": bundle_spec["theme_effect"],
        "flashMode": bundle_spec["flash_mode"],
        "supportsEditDerivation": supports_edits,
        "editSupportReason": edit_reason,
        "generationMode": bundle_mode,
        "warnings": warnings,
        "prompts": bundle_spec["prompts"],
        "promptTraits": bundle_spec["prompt_traits"],
        "sharedAnchor": shared_anchor,
        "roles": {
            role: {
                "rawImagePath": data["raw_path"].name,
                "processedImagePath": data["processed_path"].name,
                "finalImagePath": data["path"].name,
                "patchPreviewPath": data["preview_path"].name,
                "derivedFrom": data.get("derived_from"),
            }
            for role, data in role_outputs.items()
        },
        "sourceModel": IMAGE_MODEL_ID,
        "steps": {
            "ready": IMAGE_STEPS,
            "attack": WEAPON_ROLE_EDIT_SETTINGS["attack"]["steps"],
            "flash": WEAPON_ROLE_EDIT_SETTINGS["flash"]["steps"],
        },
        "guidance": {
            "ready": IMAGE_GUIDANCE_SCALE,
            "attack": WEAPON_ROLE_EDIT_SETTINGS["attack"]["guidance"],
            "flash": WEAPON_ROLE_EDIT_SETTINGS["flash"]["guidance"],
        },
        "editStrength": {
            "attack": WEAPON_ROLE_EDIT_SETTINGS["attack"]["strength"],
            "flash": WEAPON_ROLE_EDIT_SETTINGS["flash"]["strength"],
        },
        "resolution": {"width": 512, "height": 512},
        "roleTemplate": ready_template,
        "geometryCheck": {
            "muzzleDriftPx": WEAPON_ROLE_MUZZLE_DRIFT_PX,
            "maxSizeRatio": WEAPON_ROLE_BOUNDS_MAX_RATIO,
            "minSizeRatio": WEAPON_ROLE_BOUNDS_MIN_RATIO,
        },
    }
    if WRITE_AUDIT_ASSETS:
        write_asset_audit(ASSET_DIR / f"{handle}.audit.json", audit_payload)

    return {
        "primary_path": role_outputs["ready"]["path"],
        "warnings": warnings,
        "bundle": {
            "roles": {
                role: {
                    "path": data["path"],
                    "preview_path": data["preview_path"],
                    "media_type": "image/png",
                    "derived_from": data.get("derived_from"),
                    "theme_effect": bundle_spec["theme_effect"] if role == "flash" else None,
                }
                for role, data in role_outputs.items()
            },
            "metadata": {
                "replacementMode": bundle_spec["replacement_mode"],
                "handMode": bundle_spec["hand_mode"],
                "styleMode": bundle_spec["style_mode"],
                "themeEffect": bundle_spec["theme_effect"],
                "flashMode": bundle_spec["flash_mode"],
                "sourceModel": IMAGE_MODEL_ID,
                "prompts": bundle_spec["prompts"],
                "promptTraits": bundle_spec["prompt_traits"],
                "sharedAnchor": shared_anchor,
                "weaponTemplate": ready_template,
                "readyRoleSignature": ready_signature,
                "roleSettings": WEAPON_ROLE_EDIT_SETTINGS,
                "generationMode": bundle_mode,
            },
        },
    }


def save_weapon_bundle_role_artifacts(
    handle: str,
    role: str,
    raw_image: Image.Image,
    processed_image: Image.Image,
    derived_from: str | None,
    target: str,
    shared_anchor: dict[str, Any] | None,
) -> dict[str, Any]:
    raw_path = ASSET_DIR / f"{handle}.{role}.raw.png"
    processed_path = ASSET_DIR / f"{handle}.{role}.processed.png"
    final_path = ASSET_DIR / (f"{handle}.png" if role == "ready" else f"{handle}.{role}.png")
    preview_path = ASSET_DIR / f"{handle}.{role}.patch-preview.png"

    if WRITE_AUDIT_ASSETS:
        raw_image.save(raw_path, format="PNG")
        processed_image.save(processed_path, format="PNG")

    processed_image.save(final_path, format="PNG")
    create_weapon_patch_preview(processed_image, target, role, shared_anchor).save(preview_path, format="PNG")

    return {
        "raw_path": raw_path,
        "processed_path": processed_path,
        "path": final_path,
        "preview_path": preview_path,
        "derived_from": derived_from,
    }


async def generate_zombieman_enemy_bundle(
    handle: str,
    brief: str,
    frame_budget: str | None = None,
) -> dict[str, Any]:
    bundle_spec = build_zombieman_enemy_bundle_spec(brief)
    warnings: list[str] = []
    role_outputs: dict[str, dict[str, Any]] = {}

    async with state.lock:
        await ensure_image_pipeline()
        base_role = "idle_a_front"
        logger.info("image.bundle.start target=zombieman handle=%s", handle)
        logger.info("image.bundle.prompt role=%s target=zombieman prompt=%s", base_role, bundle_spec["prompts"][base_role])
        base_raw = await run_image_generation(bundle_spec["prompts"][base_role])
        base_processed = try_remove_background(base_raw)
        shared_anchor = build_enemy_shared_anchor(base_processed)
        role_outputs[base_role] = save_enemy_bundle_role_artifacts(
            handle,
            base_role,
            base_raw,
            normalize_enemy_bundle_image(base_processed, shared_anchor),
            None,
            shared_anchor,
            bundle_spec["role_metadata"][base_role],
        )

        for angle in ENEMY_AUTHORED_ROTATIONS[1:]:
            role_key = f"idle_a_{angle}"
            role_settings = ENEMY_ROLE_EDIT_SETTINGS["angle"]
            logger.info("image.bundle.prompt role=%s target=zombieman prompt=%s", role_key, bundle_spec["prompts"][role_key])
            try:
                role_raw = await run_image_generation(
                    bundle_spec["prompts"][role_key],
                    source_image=base_processed,
                    steps_override=int(role_settings["steps"]),
                    guidance_override=float(role_settings["guidance"]),
                    strength_override=float(role_settings["strength"]),
                )
                role_processed = try_remove_background(role_raw)
                role_outputs[role_key] = save_enemy_bundle_role_artifacts(
                    handle,
                    role_key,
                    role_raw,
                    normalize_enemy_bundle_image(role_processed, shared_anchor),
                    base_role,
                    shared_anchor,
                    bundle_spec["role_metadata"][role_key],
                )
            except Exception as role_error:
                message = str(role_error) if str(role_error) else role_error.__class__.__name__
                warnings.append(f"Generated zombieman {role_key} failed: {message}. Falling back to mirrored/front-derived art.")
                fallback = normalize_enemy_bundle_image(base_processed, shared_anchor)
                role_outputs[role_key] = save_enemy_bundle_role_artifacts(
                    handle,
                    role_key,
                    base_raw,
                    fallback,
                    base_role,
                    shared_anchor,
                    bundle_spec["role_metadata"][role_key],
                )

        for role_key, prompt in bundle_spec["prompts"].items():
            if role_key in role_outputs:
                continue
            derived_from = bundle_spec["role_metadata"][role_key].get("derivedFrom") or base_role
            source_role = str(derived_from)
            source_path = role_outputs.get(source_role, role_outputs[base_role])
            source_image = Image.open(source_path["path"]).convert("RGBA")
            edit_kind = "death" if role_key.startswith("death_") else "live"
            role_settings = ENEMY_ROLE_EDIT_SETTINGS[edit_kind]
            logger.info("image.bundle.prompt role=%s target=zombieman prompt=%s", role_key, prompt)
            try:
                role_raw = await run_image_generation(
                    prompt,
                    source_image=source_image,
                    steps_override=int(role_settings["steps"]),
                    guidance_override=float(role_settings["guidance"]),
                    strength_override=float(role_settings["strength"]),
                )
                role_processed = try_remove_background(role_raw)
                role_outputs[role_key] = save_enemy_bundle_role_artifacts(
                    handle,
                    role_key,
                    role_raw,
                    normalize_enemy_bundle_image(role_processed, shared_anchor),
                    source_role,
                    shared_anchor,
                    bundle_spec["role_metadata"][role_key],
                )
            except Exception as role_error:
                message = str(role_error) if str(role_error) else role_error.__class__.__name__
                warnings.append(f"Generated zombieman {role_key} failed: {message}. Using stock fallback for that state.")

    audit_payload = {
        "handle": handle,
        "kind": "enemy_sprite_set",
        "target": "zombieman",
        "brief": brief,
        "visualConcept": bundle_spec["visual_concept"],
        "promptTraits": bundle_spec["prompt_traits"],
        "roleMetadata": bundle_spec["role_metadata"],
        "prompts": bundle_spec["prompts"],
        "sharedAnchor": shared_anchor,
        "warnings": warnings,
        "sourceModel": IMAGE_MODEL_ID,
        "bundleKind": "enemy_sprite_bundle",
        "roles": {
            role: {
                "rawImagePath": data["raw_path"].name,
                "processedImagePath": data["processed_path"].name,
                "finalImagePath": data["path"].name,
                "patchPreviewPath": data["preview_path"].name,
                "derivedFrom": data.get("derived_from"),
            }
            for role, data in role_outputs.items()
        },
    }
    if WRITE_AUDIT_ASSETS:
        write_asset_audit(ASSET_DIR / f"{handle}.audit.json", audit_payload)

    return {
        "primary_path": role_outputs[base_role]["path"],
        "warnings": warnings,
        "bundle": {
            "kind": "enemy_sprite_bundle",
            "roles": {
                role: {
                    "path": data["path"],
                    "preview_path": data["preview_path"],
                    "media_type": "image/png",
                    "derived_from": data.get("derived_from"),
                    "metadata": bundle_spec["role_metadata"].get(role),
                }
                for role, data in role_outputs.items()
            },
            "metadata": {
                "sharedAnchor": shared_anchor,
                "promptTraits": bundle_spec["prompt_traits"],
                "prompts": bundle_spec["prompts"],
                "roleMetadata": bundle_spec["role_metadata"],
                "sourceModel": IMAGE_MODEL_ID,
            },
        },
    }


async def generate_doomguy_face_bundle(
    handle: str,
    brief: str,
    frame_budget: str | None = None,
) -> dict[str, Any]:
    del frame_budget
    bundle_spec = build_doomguy_face_bundle_spec(brief)
    warnings: list[str] = []
    role_outputs: dict[str, dict[str, Any]] = {}

    async with state.lock:
        await ensure_image_pipeline()
        base_role = "neutral"
        base_raw = await run_image_generation(bundle_spec["prompts"][base_role])
        base_processed = try_remove_background(base_raw)
        role_outputs[base_role] = save_hud_bundle_role_artifacts(
            handle,
            base_role,
            base_raw,
            normalize_hud_face_image(base_processed, base_role),
            None,
            bundle_spec["role_metadata"][base_role],
        )

        for role_key, prompt in bundle_spec["prompts"].items():
            if role_key == base_role:
                continue
            settings = HUD_FACE_EDIT_SETTINGS[role_key]
            try:
                role_raw = await run_image_generation(
                    prompt,
                    source_image=base_processed,
                    steps_override=int(settings["steps"]),
                    guidance_override=float(settings["guidance"]),
                    strength_override=float(settings["strength"]),
                )
                role_processed = try_remove_background(role_raw)
                role_outputs[role_key] = save_hud_bundle_role_artifacts(
                    handle,
                    role_key,
                    role_raw,
                    normalize_hud_face_image(role_processed, role_key),
                    base_role,
                    bundle_spec["role_metadata"][role_key],
                )
            except Exception as role_error:
                message = str(role_error) if str(role_error) else role_error.__class__.__name__
                warnings.append(f"Generated HUD face role {role_key} failed: {message}. Falling back to neutral face.")
                role_outputs[role_key] = save_hud_bundle_role_artifacts(
                    handle,
                    role_key,
                    base_raw,
                    normalize_hud_face_image(base_processed, role_key),
                    base_role,
                    bundle_spec["role_metadata"][role_key],
                )

    if WRITE_AUDIT_ASSETS:
        write_asset_audit(
            ASSET_DIR / f"{handle}.audit.json",
            {
                "handle": handle,
                "kind": "hud_patch_set",
                "target": "doomguy_face",
                "brief": brief,
                "promptTraits": bundle_spec["prompt_traits"],
                "prompts": bundle_spec["prompts"],
                "roleMetadata": bundle_spec["role_metadata"],
                "warnings": warnings,
                "bundleKind": "hud_patch_bundle",
                "roles": {
                    role: {
                        "rawImagePath": data["raw_path"].name,
                        "processedImagePath": data["processed_path"].name,
                        "finalImagePath": data["path"].name,
                    }
                    for role, data in role_outputs.items()
                },
            },
        )

    return {
        "primary_path": role_outputs["neutral"]["path"],
        "warnings": warnings,
        "bundle": {
            "kind": "hud_patch_bundle",
            "roles": {
                role: {
                    "path": data["path"],
                    "preview_path": data["preview_path"],
                    "media_type": "image/png",
                    "derived_from": data.get("derived_from"),
                    "metadata": bundle_spec["role_metadata"].get(role),
                }
                for role, data in role_outputs.items()
            },
            "metadata": {
                "promptTraits": bundle_spec["prompt_traits"],
                "prompts": bundle_spec["prompts"],
                "roleMetadata": bundle_spec["role_metadata"],
                "slotMap": bundle_spec["slot_map"],
                "sourceModel": IMAGE_MODEL_ID,
            },
        },
    }


def save_enemy_bundle_role_artifacts(
    handle: str,
    role: str,
    raw_image: Image.Image,
    processed_image: Image.Image,
    derived_from: str | None,
    shared_anchor: dict[str, Any],
    role_metadata: dict[str, Any],
) -> dict[str, Any]:
    raw_path = ASSET_DIR / f"{handle}.{role}.raw.png"
    processed_path = ASSET_DIR / f"{handle}.{role}.processed.png"
    final_path = ASSET_DIR / f"{handle}.{role}.png"
    preview_path = ASSET_DIR / f"{handle}.{role}.patch-preview.png"
    if WRITE_AUDIT_ASSETS:
        raw_image.save(raw_path, format="PNG")
        processed_image.save(processed_path, format="PNG")
    processed_image.save(final_path, format="PNG")
    processed_image.save(preview_path, format="PNG")
    return {
        "raw_path": raw_path,
        "processed_path": processed_path,
        "path": final_path,
        "preview_path": preview_path,
        "derived_from": derived_from,
        "shared_anchor": shared_anchor,
        "role_metadata": role_metadata,
    }


def save_hud_bundle_role_artifacts(
    handle: str,
    role: str,
    raw_image: Image.Image,
    processed_image: Image.Image,
    derived_from: str | None,
    role_metadata: dict[str, Any],
) -> dict[str, Any]:
    raw_path = ASSET_DIR / f"{handle}.{role}.raw.png"
    processed_path = ASSET_DIR / f"{handle}.{role}.processed.png"
    final_path = ASSET_DIR / f"{handle}.{role}.png"
    preview_path = ASSET_DIR / f"{handle}.{role}.patch-preview.png"
    if WRITE_AUDIT_ASSETS:
        raw_image.save(raw_path, format="PNG")
        processed_image.save(processed_path, format="PNG")
    processed_image.save(final_path, format="PNG")
    processed_image.save(preview_path, format="PNG")
    return {
        "raw_path": raw_path,
        "processed_path": processed_path,
        "path": final_path,
        "preview_path": preview_path,
        "derived_from": derived_from,
        "role_metadata": role_metadata,
    }


def build_pistol_weapon_bundle_spec(brief: str) -> dict[str, Any]:
    prompt_traits = parse_weapon_visual_traits(brief)
    visual_concept = prompt_traits["subject"]
    replacement_mode = determine_weapon_replacement_mode(brief)
    hand_mode = determine_weapon_hand_mode(brief)
    style_mode = determine_weapon_style_mode(brief, prompt_traits.get("style_override"))
    theme_effect = infer_weapon_theme_effect(brief, prompt_traits["full_description"])
    prompts = {
        "ready": build_pistol_ready_prompt(
            prompt_traits,
            replacement_mode,
            hand_mode,
            style_mode,
        ),
        "attack": build_pistol_attack_edit_prompt(prompt_traits, theme_effect),
        "flash": build_pistol_flash_edit_prompt(prompt_traits, theme_effect),
    }
    return {
        "visual_concept": visual_concept,
        "prompt_traits": prompt_traits,
        "replacement_mode": replacement_mode,
        "hand_mode": hand_mode,
        "style_mode": style_mode,
        "theme_effect": theme_effect,
        "flash_mode": "emission_only",
        "prompts": prompts,
    }


def build_enemy_sprite_prompt(target: str, brief: str) -> str:
    prompt_traits = parse_enemy_visual_traits(brief)
    style_override = prompt_traits.get("style_override")
    style_instruction = (
        f"follow {style_override} while keeping gritty readable monster detail"
        if style_override
        else "rich painted shading muted earthy colors darker midtones subtle grime"
    )
    trait_instruction = (
        f"required visible traits {' '.join(prompt_traits.get('required_traits', []))}"
        if prompt_traits.get("required_traits")
        else f"primary subject {prompt_traits['subject']}"
    )
    prompt = (
        f"doom authentic enemy replacement for {target} full creature {prompt_traits['full_description']} "
        f"{trait_instruction} {style_instruction} "
        "front facing or three quarter actor billboard full body centered grounded feet readable silhouette "
        "isolated on white background transparent sprite no scene no player hands no weapon view no text no ui "
        "leave generous padding around horns limbs hats hair and accessories"
    )
    return truncate_prompt_words(prompt, MAX_IMAGE_PROMPT_WORDS)


def build_zombieman_enemy_bundle_spec(brief: str) -> dict[str, Any]:
    prompt_traits = parse_enemy_visual_traits(brief)
    full_description = expand_named_enemy_description(prompt_traits["full_description"])
    prompt_traits = {
        **prompt_traits,
        "subject": expand_named_enemy_description(prompt_traits["subject"]),
        "full_description": full_description,
    }
    keep_gun = not prompt_explicitly_removes_enemy_gun(brief)
    prompts: dict[str, str] = {}
    role_metadata: dict[str, dict[str, Any]] = {}

    prompts["idle_a_front"] = truncate_prompt_words(
        build_zombieman_base_prompt(prompt_traits, keep_gun),
        MAX_IMAGE_PROMPT_WORDS,
    )
    role_metadata["idle_a_front"] = {
        "frameId": 0,
        "rotation": "front",
        "stateRole": "idle_a",
        "defaultWeaponPresent": keep_gun,
    }

    for angle in ENEMY_AUTHORED_ROTATIONS[1:]:
        role_key = f"idle_a_{angle}"
        prompts[role_key] = truncate_prompt_words(
            build_zombieman_angle_prompt(prompt_traits, angle, keep_gun),
            MAX_IMAGE_EDIT_PROMPT_WORDS,
        )
        role_metadata[role_key] = {
            "frameId": 0,
            "rotation": angle,
            "stateRole": "idle_a",
            "derivedFrom": "idle_a_front",
            "defaultWeaponPresent": keep_gun,
        }

    frame_id_map = {
        "idle_a": 0,
        "idle_b": 1,
        "run_a": 0,
        "run_b": 1,
        "run_c": 2,
        "run_d": 3,
        "attack_a": 4,
        "attack_b": 5,
        "pain_a": 6,
        "death_a": 7,
        "death_b": 8,
        "death_c": 9,
        "death_d": 10,
        "death_e": 11,
    }

    for role_name in ZOMBIEMAN_LIVE_FRAME_ROLES:
        for angle in ENEMY_AUTHORED_ROTATIONS:
            role_key = f"{role_name}_{angle}"
            if role_key in prompts:
                continue
            prompts[role_key] = truncate_prompt_words(
                build_zombieman_live_role_prompt(prompt_traits, role_name, angle, keep_gun),
                MAX_IMAGE_EDIT_PROMPT_WORDS,
            )
            role_metadata[role_key] = {
                "frameId": frame_id_map[role_name],
                "rotation": angle,
                "stateRole": role_name,
                "derivedFrom": f"idle_a_{angle}",
                "defaultWeaponPresent": keep_gun,
            }

    for role_name in ZOMBIEMAN_DEATH_FRAME_ROLES:
        role_key = f"{role_name}_front"
        prompts[role_key] = truncate_prompt_words(
            build_zombieman_death_prompt(prompt_traits, role_name),
            MAX_IMAGE_EDIT_PROMPT_WORDS,
        )
        role_metadata[role_key] = {
            "frameId": frame_id_map[role_name],
            "rotation": "front",
            "stateRole": role_name,
            "derivedFrom": "idle_a_front",
            "defaultWeaponPresent": keep_gun,
        }

    return {
        "visual_concept": prompt_traits["subject"],
        "prompt_traits": prompt_traits,
        "prompts": prompts,
        "role_metadata": role_metadata,
    }


def build_doomguy_face_bundle_spec(brief: str) -> dict[str, Any]:
    prompt_traits = parse_enemy_visual_traits(brief)
    full_description = expand_named_enemy_description(prompt_traits["full_description"])
    prompt_traits = {
        **prompt_traits,
        "subject": expand_named_enemy_description(prompt_traits["subject"]),
        "full_description": full_description,
    }
    prompts = {
        "neutral": truncate_prompt_words(build_hud_face_neutral_prompt(prompt_traits), MAX_IMAGE_PROMPT_WORDS),
        "look_left": truncate_prompt_words(build_hud_face_expression_prompt(prompt_traits, "look left"), MAX_IMAGE_EDIT_PROMPT_WORDS),
        "look_right": truncate_prompt_words(build_hud_face_expression_prompt(prompt_traits, "look right"), MAX_IMAGE_EDIT_PROMPT_WORDS),
        "pain": truncate_prompt_words(build_hud_face_expression_prompt(prompt_traits, "pain grimace"), MAX_IMAGE_EDIT_PROMPT_WORDS),
        "evil_grin": truncate_prompt_words(build_hud_face_expression_prompt(prompt_traits, "evil grin"), MAX_IMAGE_EDIT_PROMPT_WORDS),
        "dead": truncate_prompt_words(build_hud_face_expression_prompt(prompt_traits, "dead lifeless face"), MAX_IMAGE_EDIT_PROMPT_WORDS),
    }
    slot_map = build_hud_face_slot_map()
    role_metadata = {
        role: {
            "canonicalExpression": role,
            "mappedSlots": slots,
            "size": HUD_FACE_ROLE_SPECS[role]["size"],
        }
        for role, slots in slot_map.items()
    }
    return {
        "prompt_traits": prompt_traits,
        "prompts": prompts,
        "role_metadata": role_metadata,
        "slot_map": slot_map,
    }


def build_zombieman_base_prompt(prompt_traits: dict[str, Any], keep_gun: bool) -> str:
    gun_instruction = (
        "carry a classic zombieman pistol in one hand with readable muzzle side"
        if keep_gun
        else "no gun or firearm visible"
    )
    return (
        f"doom authentic humanoid enemy actor full body {prompt_traits['full_description']} "
        f"{' '.join(prompt_traits.get('required_traits', []))} {gun_instruction} "
        "front facing grounded feet readable silhouette gritty painted shading muted earthy colors darker midtones subtle grime "
        "isolated on white background transparent sprite no scene no player hands no poster no text no ui"
    )


def build_zombieman_angle_prompt(prompt_traits: dict[str, Any], angle: str, keep_gun: bool) -> str:
    gun_instruction = "keep the pistol and the same hand side" if keep_gun else "no gun visible"
    return (
        f"same enemy identity same outfit same body shape same accessories as the reference frame "
        f"rotate to {angle.replace('_', ' ')} classic doom enemy angle {gun_instruction} "
        "same full body sprite framing grounded feet no camera zoom no scene no text"
    )


def build_zombieman_live_role_prompt(
    prompt_traits: dict[str, Any],
    role_name: str,
    angle: str,
    keep_gun: bool,
) -> str:
    role_phrase = {
        "idle_b": "slight breathing idle variation",
        "run_a": "running step forward",
        "run_b": "running stride variation",
        "run_c": "running stride with opposite leg lead",
        "run_d": "running recovery stride",
        "attack_a": "attack windup aiming the pistol",
        "attack_b": "attack firing pose with recoil",
        "pain_a": "pain recoil hit reaction",
    }.get(role_name, "minor animation variation")
    gun_instruction = "keep the pistol readable" if keep_gun else "no gun visible"
    return (
        f"same enemy identity same {prompt_traits['full_description']} from the angle reference "
        f"{angle.replace('_', ' ')} {role_phrase} {gun_instruction} "
        "same scale same grounded feet same camera same silhouette family no scene no text"
    )


def build_zombieman_death_prompt(prompt_traits: dict[str, Any], role_name: str) -> str:
    death_phrase = {
        "death_a": "death start recoil",
        "death_b": "death collapse mid fall",
        "death_c": "death fall impact",
        "death_d": "death settling on the floor",
        "death_e": "death final still frame on the floor",
    }[role_name]
    return (
        f"same enemy identity same {prompt_traits['full_description']} front facing {death_phrase} "
        "classic doom enemy death sprite no scene no text same character consistency"
    )


def build_hud_face_neutral_prompt(prompt_traits: dict[str, Any]) -> str:
    return (
        f"classic doom status face portrait of {prompt_traits['full_description']} "
        "neutral expression face only cropped tightly to the head transparent background no shoulders no ui no scenery "
        "gritty painted shading muted earthy colors darker midtones"
    )


def build_hud_face_expression_prompt(prompt_traits: dict[str, Any], expression: str) -> str:
    return (
        f"same face identity as the reference portrait of {prompt_traits['full_description']} "
        f"{expression} classic doom status face crop transparent background no shoulders no ui no scene"
    )


def build_hud_face_slot_map() -> dict[str, list[int]]:
    neutral: list[int] = []
    look_left: list[int] = []
    look_right: list[int] = []
    pain: list[int] = []
    evil: list[int] = []
    for pain_index in range(5):
        base = pain_index * 8
        neutral.extend([base + 0, base + 1, base + 2])
        look_right.append(base + 3)
        look_left.append(base + 4)
        pain.extend([base + 5, base + 7])
        evil.append(base + 6)
    neutral = [slot for slot in neutral if slot >= 0]
    neutral.append(40)
    return {
        "neutral": neutral,
        "look_left": look_left,
        "look_right": look_right,
        "pain": pain,
        "evil_grin": evil,
        "dead": [41],
    }


def expand_named_enemy_description(value: str) -> str:
    normalized = value.lower()
    if "guy fieri" in normalized:
        return (
            "blonde spiky haired man with black glasses, a blonde goatee, a big belly, "
            "a rock and roll t shirt with red and yellow flames, bright blue jeans, and sneakers"
        )
    return value


def prompt_explicitly_removes_enemy_gun(brief: str) -> bool:
    normalized = brief.lower()
    if any(token in normalized for token in ("no gun", "without a gun", "unarmed", "no pistol", "no firearm")):
        return True
    alternate_prop_patterns = (
        r"\b(?:holding|carrying|wielding|playing)\s+(?:a|an|the)?\s*(guitar|microphone|sword|axe|bat|hammer|staff|wand|chainsaw)\b",
        r"\bwith\s+(?:a|an|the)?\s*(guitar|microphone|sword|axe|bat|hammer|staff|wand|chainsaw)\b",
        r"\binstead of\s+(?:a|an|the)?\s*(gun|pistol|firearm)\b",
    )
    return any(re.search(pattern, normalized) for pattern in alternate_prop_patterns)


def build_enemy_shared_anchor(image: Image.Image) -> dict[str, Any]:
    bounds = find_nontransparent_bounds(image.convert("RGBA"))
    if bounds is None:
        bounds = (0, 0, image.width - 1, image.height - 1)
    x0, y0, x1, y1 = bounds
    placement = fit_bounds_into_box(
        x1 - x0 + 1,
        y1 - y0 + 1,
        ENEMY_TARGET_SPRITE_BOX["width"],
        ENEMY_TARGET_SPRITE_BOX["height"],
        0,
        0,
        0,
    )
    placement["baseX"] = (ENEMY_RENDER_BOX["width"] - placement["drawWidth"]) // 2
    placement["baseY"] = ENEMY_RENDER_BOX["height"] - ENEMY_RENDER_MARGINS["bottom"] - placement["drawHeight"]
    return {
        "sourceBounds": {"x": x0, "y": y0, "width": x1 - x0 + 1, "height": y1 - y0 + 1},
        "placement": placement,
        "footAnchor": {"x": placement["baseX"] + placement["drawWidth"] // 2, "y": placement["baseY"] + placement["drawHeight"]},
        "centerline": placement["baseX"] + placement["drawWidth"] // 2,
        "renderBox": ENEMY_RENDER_BOX,
    }


def normalize_enemy_bundle_image(image: Image.Image, shared_anchor: dict[str, Any]) -> Image.Image:
    source = image.convert("RGBA")
    bounds = find_nontransparent_bounds(source)
    if bounds is None:
        bounds = (0, 0, source.width - 1, source.height - 1)
    x0, y0, x1, y1 = bounds
    crop = source.crop((x0, y0, x1 + 1, y1 + 1))
    placement = shared_anchor["placement"]
    canvas = Image.new("RGBA", (ENEMY_RENDER_BOX["width"], ENEMY_RENDER_BOX["height"]), (0, 0, 0, 0))
    resized = crop.resize((placement["drawWidth"], placement["drawHeight"]), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, (placement["baseX"], placement["baseY"]))
    return canvas


def normalize_hud_face_image(image: Image.Image, role: str) -> Image.Image:
    spec = HUD_FACE_ROLE_SPECS[role]["size"]
    width = int(spec["width"])
    height = int(spec["height"])
    source = image.convert("RGBA")
    bounds = find_nontransparent_bounds(source)
    if bounds is None:
        bounds = (0, 0, source.width - 1, source.height - 1)
    x0, y0, x1, y1 = bounds
    crop = source.crop((x0, y0, x1 + 1, y1 + 1))
    placement = fit_bounds_into_box(crop.width, crop.height, width, height, 1, 1, 0)
    resized = crop.resize((placement["drawWidth"], placement["drawHeight"]), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.alpha_composite(resized, (placement["baseX"], placement["baseY"]))
    return canvas


def fit_bounds_into_box(
    source_width: int,
    source_height: int,
    box_width: int,
    box_height: int,
    side_margin: int,
    top_margin: int,
    bottom_margin: int,
) -> dict[str, int]:
    usable_width = max(1, box_width - side_margin * 2)
    usable_height = max(1, box_height - top_margin - bottom_margin)
    scale = min(usable_width / max(1, source_width), usable_height / max(1, source_height))
    draw_width = max(1, int(round(source_width * scale)))
    draw_height = max(1, int(round(source_height * scale)))
    base_x = (box_width - draw_width) // 2
    base_y = box_height - bottom_margin - draw_height
    return {
        "baseX": int(base_x),
        "baseY": int(base_y),
        "drawWidth": int(draw_width),
        "drawHeight": int(draw_height),
    }


def build_pistol_ready_prompt(
    prompt_traits: dict[str, Any],
    replacement_mode: str,
    hand_mode: str,
    style_mode: str,
) -> str:
    subject = prompt_traits["subject"]
    full_description = prompt_traits["full_description"]
    required_traits = prompt_traits.get("required_traits", [])
    style_override = prompt_traits.get("style_override")
    concept_instruction = (
        f"{full_description} is the entire held object"
        if replacement_mode != "hybrid"
        else f"{full_description} hybrid held object"
    )
    hand_instruction = (
        "dominant hand only with thumb and fingers visible short wrist"
        if hand_mode == "stock_like_default"
        else "use the custom requested limb from the prompt and keep only one visible hand or equivalent limb"
    )
    style_instruction = (
        "rich painted shading muted browns reds and greens darker midtones subtle grime"
        if style_mode == "doom_authentic"
        else f"follow {style_override or 'the requested'} style while keeping gritty readable sprite detail"
    )
    replacement_negative = (
        "no visible firearm parts no second hand no forearm"
        if replacement_mode != "hybrid"
        else "hybrid look only because prompt explicitly requested it no second hand"
    )
    subject_instruction = (
        f"{full_description} only"
        if replacement_mode != "hybrid"
        else f"{full_description} with limited firearm silhouette only because prompt explicitly requested a hybrid"
    )
    trait_instruction = (
        f"required visible traits {' '.join(required_traits)}"
        if required_traits
        else f"primary subject {subject}"
    )
    prompt = (
        f"first person retro fps sprite rear-held composition {hand_instruction} "
        f"bottom-center forward-ready pose {subject_instruction} {concept_instruction} {trait_instruction} {style_instruction} "
        "isolated on white background no scene no cartoon look no toy look "
        f"{replacement_negative}"
    )
    return truncate_prompt_words(prompt, MAX_IMAGE_PROMPT_WORDS)


def build_pistol_attack_edit_prompt(prompt_traits: dict[str, Any], theme_effect: str) -> str:
    full_description = prompt_traits["full_description"]
    required_traits = prompt_traits.get("required_traits", [])
    trait_instruction = f"keep {' '.join(required_traits)}" if required_traits else ""
    prompt = (
        f"same sprite same hand same placement same {full_description} from the ready frame "
        "subtle recoil pose and muzzle kick while preserving exact silhouette, anchor, and camera angle "
        "minimal pixel movement only in the right side region near the muzzle "
        f"{trait_instruction} no new gun parts no second hand no scene no camera change no text "
        f"theme aware attack motion for {theme_effect} based firing"
    )
    return truncate_prompt_words(prompt, MAX_IMAGE_EDIT_PROMPT_WORDS)


def build_pistol_flash_edit_prompt(prompt_traits: dict[str, Any], theme_effect: str) -> str:
    full_description = prompt_traits["full_description"]
    prompt = (
        f"same sprite same placement same {full_description} from the ready frame "
        f"add a small, centered themed discharge effect at the firing end using {theme_effect} "
        "emission-only local flash, preserve silhouette, anchor, placement, and camera angle "
        "no weapon body no hand no second sprite body no generic muzzle flash no new gun parts "
        "no second hand no scene no camera change no text"
    )
    return truncate_prompt_words(prompt, MAX_IMAGE_EDIT_PROMPT_WORDS)


def determine_weapon_replacement_mode(brief: str) -> str:
    normalized = brief.lower()
    if any(token in normalized for token in ("hybrid", "burger pistol", "pistol hybrid", "gun made of")):
        return "hybrid"
    return "full_swap"


def determine_weapon_hand_mode(brief: str) -> str:
    normalized = brief.lower()
    if any(
        token in normalized
        for token in ("dog paw", "paw", "claw", "tentacle", "hulk arm", "robot hand", "skeletal hand")
    ):
        return "generated_limb"
    return "stock_like_default"


def determine_weapon_style_mode(brief: str, style_override: str | None = None) -> str:
    normalized = brief.lower()
    if style_override:
        return "prompt_override"
    if any(
        token in normalized
        for token in ("anime", "realistic", "photoreal", "comic", "watercolor", "clay", "lego", "cartoon", "pixel art")
    ):
        return "prompt_override"
    return "doom_authentic"


def infer_weapon_theme_effect(brief: str, visual_concept: str) -> str:
    normalized = f"{brief} {visual_concept}".lower()
    if any(token in normalized for token in ("burger", "hamburger", "sandwich", "pizza", "taco", "food", "meat", "ketchup", "mustard")):
        return "food_emission"
    if any(token in normalized for token in ("bubble", "foam", "soap")):
        return "bubble_emission"
    if any(token in normalized for token in ("fish", "water", "ocean", "aquatic", "splash")):
        return "water_emission"
    if any(token in normalized for token in ("shrimp", "prawn", "crab", "lobster", "shellfish")):
        return "water_emission"
    if any(token in normalized for token in ("magic", "sparkle", "candy", "star", "crystal")):
        return "sparkle_emission"
    return "impact_emission"


def parse_weapon_visual_traits(brief: str) -> dict[str, Any]:
    normalized = " ".join(brief.strip().split())
    if not normalized:
        return {
            "subject": "weapon",
            "full_description": "weapon",
            "required_traits": [],
            "style_override": None,
        }

    style_override = extract_explicit_style_phrase(normalized)
    description_source = remove_style_phrase(normalized, style_override)
    object_phrase = extract_replacement_object_phrase(description_source)
    full_description = normalize_weapon_trait_phrase(object_phrase or description_source)
    subject, required_traits = split_subject_and_traits(full_description)
    return {
        "subject": subject or "weapon",
        "full_description": full_description or (subject or "weapon"),
        "required_traits": required_traits,
        "style_override": style_override,
    }


def parse_enemy_visual_traits(brief: str) -> dict[str, Any]:
    normalized = " ".join(brief.strip().split())
    if not normalized:
        return {
            "subject": "enemy",
            "full_description": "enemy",
            "required_traits": [],
            "style_override": None,
        }

    style_override = extract_explicit_style_phrase(normalized)
    description_source = remove_style_phrase(normalized, style_override)
    object_phrase = extract_enemy_replacement_phrase(description_source)
    full_description = normalize_enemy_trait_phrase(object_phrase or description_source)
    subject, required_traits = split_subject_and_traits(full_description)
    return {
        "subject": subject or "enemy",
        "full_description": full_description or (subject or "enemy"),
        "required_traits": required_traits,
        "style_override": style_override,
    }


def extract_explicit_style_phrase(brief: str) -> str | None:
    normalized = brief.lower()
    style_patterns = (
        r"\bin\s+([a-z0-9][a-z0-9\s\-]{2,40}\s+style)\b",
        r"\b([a-z0-9][a-z0-9\s\-]{2,40}\s+style)\b",
        r"\b(watercolor|anime|comic|photoreal|photorealistic|realistic|clay|lego|pixel art)\b",
    )
    for pattern in style_patterns:
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if match:
            return " ".join(match.group(1).split())
    return None


def remove_style_phrase(brief: str, style_phrase: str | None) -> str:
    if not style_phrase:
        return brief
    pattern = re.escape(style_phrase)
    cleaned = re.sub(rf"\bin\s+{pattern}\b", "", brief, flags=re.IGNORECASE)
    cleaned = re.sub(rf"\b{pattern}\b", "", cleaned, flags=re.IGNORECASE)
    return " ".join(cleaned.split())


def extract_replacement_object_phrase(brief: str) -> str:
    patterns = (
        r"(?:turn|transform|swap).{0,40}(?:pistol|gun|weapon|firearm).{0,20}into\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
        r"replace.{0,40}(?:pistol|gun|weapon|firearm).{0,20}with\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
        r"(?:as)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
        r"(?:into)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
    )
    for pattern in patterns:
        match = re.search(pattern, brief, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip(" .,;:!?")
    return brief.strip(" .,;:!?")


def extract_enemy_replacement_phrase(brief: str) -> str:
    patterns = (
        r"(?:turn|transform|swap).{0,48}(?:zombieman|zombie man|zombie|enemy|monster).{0,20}into\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
        r"replace.{0,48}(?:zombieman|zombie man|zombie|enemy|monster).{0,20}with\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
        r"(?:as)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
        r"(?:into)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,120})",
    )
    for pattern in patterns:
        match = re.search(pattern, brief, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip(" .,;:!?")
    return brief.strip(" .,;:!?")


def normalize_weapon_trait_phrase(value: str) -> str:
    candidate = value.strip().lower()
    candidate = re.sub(r"\b(it|them|this|that)\b", "", candidate)
    candidate = re.sub(r"\b(sprite|graphic|appearance|weapon|gun|pistol)\b", "", candidate)
    candidate = " ".join(candidate.split())
    return candidate.strip(" .,;:!?")


def normalize_enemy_trait_phrase(value: str) -> str:
    candidate = value.strip().lower()
    candidate = re.sub(r"\b(it|them|this|that)\b", "", candidate)
    candidate = re.sub(r"\b(sprite|graphic|appearance|enemy|monster|zombieman|zombie)\b", "", candidate)
    candidate = " ".join(candidate.split())
    return candidate.strip(" .,;:!?")


def split_subject_and_traits(description: str) -> tuple[str, list[str]]:
    if not description:
        return "weapon", []

    for separator in (" wearing ", " with ", " holding ", " carrying ", " topped with ", " made of ", " made from "):
        if separator in description:
            subject, rest = description.split(separator, 1)
            subject = subject.strip(" ,.;:!?")
            rest = rest.strip(" ,.;:!?")
            if separator.strip() == "with":
                traits = [
                    f"with {part.strip()}"
                    for part in re.split(r"\s+and\s+|\s+with\s+|,\s*", rest)
                    if part.strip()
                ]
            else:
                traits = [f"{separator.strip()} {rest}"]
            return subject or description, traits

    return description, []


def get_local_weapon_bundle_edit_support(target: str) -> tuple[bool, str]:
    if target != "pistol":
        return False, f"{target} edit/reference derivation is not implemented in this build"
    if "flux.2-klein" in IMAGE_MODEL_ID.lower():
        return True, state.active_image_backend or f"diffusers:flux2_klein:{IMAGE_MODEL_ID}"
    return False, f"{IMAGE_MODEL_ID} does not expose a compatible local image edit/reference pipeline in this build"


def apply_edit_strength_blend(base_image: Image.Image, edited_image: Image.Image, strength: float) -> Image.Image:
    # Flux2Klein currently exposes image conditioning but no explicit diffusion strength knob.
    # Blend toward the edited result to enforce stable, role-specific deformation intensity.
    blend_amount = max(0.0, min(1.0, float(strength)))
    base_rgba = base_image.convert("RGBA")
    edited_rgba = edited_image.convert("RGBA")
    if base_rgba.size != edited_rgba.size:
        edited_rgba = edited_rgba.resize(base_rgba.size, Image.Resampling.BICUBIC)
    return Image.blend(base_rgba, edited_rgba, blend_amount)


def isolate_flash_emission_overlay(base_image: Image.Image, flash_image: Image.Image) -> Image.Image:
    base_rgba = np.array(base_image.convert("RGBA"), dtype=np.int16)
    flash_rgba = np.array(flash_image.convert("RGBA"), dtype=np.int16)
    if base_rgba.shape != flash_rgba.shape:
        resized = flash_image.convert("RGBA").resize(base_image.size, Image.Resampling.BICUBIC)
        flash_rgba = np.array(resized, dtype=np.int16)

    alpha_base = base_rgba[:, :, 3]
    alpha_flash = flash_rgba[:, :, 3]
    color_delta = np.abs(flash_rgba[:, :, :3] - base_rgba[:, :, :3]).sum(axis=2)
    emission_mask = (
        (alpha_flash >= 48)
        & (
            (alpha_flash >= alpha_base + 24)
            | (color_delta >= 92)
        )
    )

    output = np.zeros_like(flash_rgba, dtype=np.uint8)
    output[:, :, :3] = np.clip(flash_rgba[:, :, :3], 0, 255).astype(np.uint8)
    output[:, :, 3] = np.where(emission_mask, np.clip(alpha_flash, 0, 255), 0).astype(np.uint8)
    image = Image.fromarray(output, mode="RGBA")
    return postprocess_flash_overlay(image)


def postprocess_flash_overlay(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    rgba = ImageEnhance.Brightness(rgba).enhance(1.18)
    data = np.array(rgba, dtype=np.uint8)
    alpha = data[:, :, 3]
    alpha[alpha < 72] = 0
    alpha[(alpha >= 72) & (alpha < 128)] = np.asarray(alpha[(alpha >= 72) & (alpha < 128)] * 0.8, dtype=np.uint8)
    data[:, :, 3] = alpha
    return Image.fromarray(data, mode="RGBA")


def has_meaningful_flash_overlay(image: Image.Image) -> bool:
    alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[:, :, 3]
    return int(np.count_nonzero(alpha >= 72)) >= 18


def build_shared_weapon_anchor(
    image: Image.Image,
    target: str,
    weapon_template: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rgba = image.convert("RGBA")
    bounds = find_nontransparent_bounds(rgba)
    box_width, box_height = get_weapon_render_box(target)
    side, top, bottom = get_weapon_variant_margins(target, "ready")
    if bounds is None:
        bounds = (0, 0, image.width - 1, image.height - 1)
    placement = fit_crop_bounds_into_box(bounds, box_width, box_height, side, top, bottom)
    x0, y0, x1, y1 = bounds
    source_bounds = {
        "x": x0,
        "y": y0,
        "width": x1 - x0 + 1,
        "height": y1 - y0 + 1,
    }
    source_canvas = {"width": image.width, "height": image.height}
    scale = float(placement["drawWidth"]) / max(1, source_bounds["width"])
    placement["scale"] = scale
    template = weapon_template if isinstance(weapon_template, dict) else build_weapon_template_profile(image)
    muzzle = template.get("muzzlePoint", {})
    muzzle_x = int(muzzle.get("x", x0 + int(source_bounds["width"] * 0.72)))
    muzzle_y = int(muzzle.get("y", y0 + int(source_bounds["height"] * 0.24)))
    flash_origin_x = int(round(placement["baseX"] + (muzzle_x - x0) * scale))
    flash_origin_y = int(round(placement["baseY"] + (muzzle_y - y0) * scale))
    if target == "pistol":
        flash_origin_x = int(round(placement["baseX"] + placement["drawWidth"] * 0.56))
        flash_origin_y = int(round(placement["baseY"] + placement["drawHeight"] * 0.16))
    return {
        "sourceCanvas": source_canvas,
        "sourceBounds": source_bounds,
        "placement": placement,
        "renderBox": {"width": box_width, "height": box_height},
        "flashOrigin": {
            "x": flash_origin_x,
            "y": flash_origin_y,
        },
        "weaponTemplate": template,
    }


def create_weapon_patch_preview(
    image: Image.Image,
    target: str,
    role: str,
    shared_anchor: dict[str, Any] | None = None,
) -> Image.Image:
    rgba = image.convert("RGBA")
    if shared_anchor:
        canvas = Image.new(
            "RGBA",
            (int(shared_anchor["renderBox"]["width"]), int(shared_anchor["renderBox"]["height"])),
            (0, 0, 0, 0),
        )
        draw_full_image_using_anchor(canvas, rgba, shared_anchor)
        return canvas

    bounds = find_nontransparent_bounds(rgba)
    box_width, box_height = get_weapon_render_box(target)
    side, top, bottom = get_weapon_variant_margins(target, role)
    canvas = Image.new("RGBA", (box_width, box_height), (0, 0, 0, 0))
    if bounds is None:
        return canvas
    placement = fit_crop_bounds_into_box(bounds, box_width, box_height, side, top, bottom)
    draw_crop_using_placement(canvas, rgba, bounds, placement)
    return canvas


def fit_crop_bounds_into_box(
    bounds: tuple[int, int, int, int],
    box_width: int,
    box_height: int,
    side: int,
    top: int,
    bottom: int,
) -> dict[str, int | float]:
    x0, y0, x1, y1 = bounds
    crop_width = max(1, x1 - x0 + 1)
    crop_height = max(1, y1 - y0 + 1)
    inner_width = max(1, box_width - side * 2)
    inner_height = max(1, box_height - top - bottom)
    scale = min(inner_width / crop_width, inner_height / crop_height)
    draw_width = max(1, round(crop_width * scale))
    draw_height = max(1, round(crop_height * scale))
    return {
        "baseX": round((box_width - draw_width) / 2),
        "baseY": round(box_height - bottom - draw_height),
        "drawWidth": draw_width,
        "drawHeight": draw_height,
        "scale": scale,
    }


def draw_crop_using_placement(
    canvas: Image.Image,
    source_image: Image.Image,
    bounds: tuple[int, int, int, int],
    placement: dict[str, int | float],
) -> None:
    x0, y0, x1, y1 = bounds
    crop = source_image.crop((x0, y0, x1 + 1, y1 + 1))
    resized = crop.resize(
        (int(placement["drawWidth"]), int(placement["drawHeight"])),
        Image.Resampling.NEAREST,
    )
    canvas.alpha_composite(resized, (int(placement["baseX"]), int(placement["baseY"])))


def draw_full_image_using_anchor(canvas: Image.Image, source_image: Image.Image, shared_anchor: dict[str, Any]) -> None:
    source_bounds = shared_anchor["sourceBounds"]
    placement = shared_anchor["placement"]
    scale = float(placement.get("scale", 1.0))
    draw_width = max(1, round(source_image.width * scale))
    draw_height = max(1, round(source_image.height * scale))
    resized = source_image.resize((draw_width, draw_height), Image.Resampling.NEAREST)
    dest_x = int(round(float(placement["baseX"]) - int(source_bounds["x"]) * scale))
    dest_y = int(round(float(placement["baseY"]) - int(source_bounds["y"]) * scale))
    canvas.alpha_composite(resized, (dest_x, dest_y))


def find_nontransparent_bounds(image: Image.Image) -> tuple[int, int, int, int] | None:
    data = np.array(image.convert("RGBA"), dtype=np.uint8)
    alpha = data[:, :, 3]
    ys, xs = np.where(alpha >= 32)
    if ys.size == 0 or xs.size == 0:
        return None
    pad = WEAPON_BUNDLE_READY_BOUNDS_PADDING
    min_x = max(0, int(xs.min()) - pad)
    min_y = max(0, int(ys.min()) - pad)
    max_x = min(image.width - 1, int(xs.max()) + pad)
    max_y = min(image.height - 1, int(ys.max()) + pad)
    return min_x, min_y, max_x, max_y


def get_weapon_render_box(target: str) -> tuple[int, int]:
    if target == "fist":
        return 128, 112
    if target in {"chainsaw", "bfg9000"}:
        return 176, 128
    if target == "rocket_launcher":
        return 168, 120
    return 160, 112


def get_weapon_variant_margins(target: str, role: str) -> tuple[int, int, int]:
    is_large_weapon = target in {"chainsaw", "bfg9000", "rocket_launcher"}
    side = 18 if is_large_weapon else 16
    top = 20 if role == "flash" else 16 if role == "attack" else 12
    bottom = 4 if target == "fist" else 10 if role == "attack" else 6
    return side, top, bottom


def build_sound_pack_prompt(brief: str) -> str:
    concept = extract_audio_concept(brief)
    normalized_brief = " ".join(brief.lower().split())
    explicit_weapon_mix = any(
        token in normalized_brief
        for token in (
            "gunshot",
            "weapon shot",
            "weapon fire",
            "pistol shot",
            "pistol fire",
            "gun fire",
            "firearm",
            "mixed with",
            "blended with",
            "combined with",
            "hybrid",
        )
    )
    if explicit_weapon_mix:
        prompt = (
            f"{concept}, single non-speech game sound effect, preserve any explicitly requested weapon-fire blend, "
            "no speech, no narration, no text to speech, no dialogue"
        )
    else:
        prompt = (
            f"{concept}, single non-speech game sound effect, literal requested sound only, "
            "no gunshot, no weapon fire, no pistol blast, no firearm mechanics, no speech, no narration, no text to speech, no dialogue"
        )
    return truncate_prompt_words(prompt, MAX_AUDIO_PROMPT_WORDS)


def build_music_track_prompt(brief: str) -> str:
    concept = extract_audio_concept(brief)
    return truncate_prompt_words(f"{concept}, instrumental only, no lyrics", MAX_AUDIO_PROMPT_WORDS)


AUDIO_PROFILE_BY_KIND: dict[str, dict[str, Any]] = {
    "sound_pack": {
        "kind": "sound_pack",
        "target_hint": "pistol",
        "duration_seconds": SFX_DURATION_SECONDS,
        "min_duration_seconds": 0.5,
        "max_duration_seconds": 24.0,
        "fade_seconds": 0.01,
        "prompt_builder": build_sound_pack_prompt,
    },
    "music_track": {
        "kind": "music_track",
        "target_hint": "level",
        "duration_seconds": min(max(SFX_DURATION_SECONDS, 12.0), 60.0),
        "min_duration_seconds": 12.0,
        "max_duration_seconds": 60.0,
        "fade_seconds": 0.05,
        "prompt_builder": build_music_track_prompt,
        "enabled": False,
    },
}


def get_audio_profile(kind: str) -> dict[str, Any] | None:
    profile = AUDIO_PROFILE_BY_KIND.get(kind)
    if not profile:
        return None
    if kind == "music_track" and not profile.get("enabled", False):
        return None
    return profile


def build_image_prompt(kind: str, target: str, brief: str) -> str:
    concept = extract_visual_concept(brief)
    if kind == "weapon_sprite_set":
        if target == "pistol":
            return build_pistol_weapon_bundle_spec(brief)["prompts"]["ready"]
        prompt = (
            f"{brief} first person retro fps replacement sprite {concept} as the full visible held object "
            "rear-held bottom-center framing muted gritty painted shading isolated on white background "
            "no visible firearm parts no scene no cartoon look"
        )
        return truncate_prompt_words(prompt, MAX_IMAGE_PROMPT_WORDS)
    if kind == "enemy_sprite_set":
        return build_enemy_sprite_prompt(target, brief)
    return truncate_prompt_words(
        f"doom-style sprite asset based on {concept}, full vivid color, isolated subject.",
        MAX_IMAGE_PROMPT_WORDS,
    )


def build_audio_prompt(kind: str, brief: str) -> str:
    profile = get_audio_profile(kind)
    if not profile:
        concept = extract_audio_concept(brief)
        return truncate_prompt_words(concept, MAX_AUDIO_PROMPT_WORDS)
    return profile["prompt_builder"](brief)


def is_image_kind(kind: str) -> bool:
    return kind in MVP_IMAGE_KINDS


def is_audio_kind(kind: str) -> bool:
    return kind in MVP_AUDIO_KINDS


def build_handle(kind: str, target: str, mod_id: str) -> str:
    suffix = uuid.uuid4().hex[:10]
    cleaned = sanitize(f"{kind}_{target}_{mod_id}")
    return f"local_{cleaned}_{suffix}"


def sanitize(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\\-]+", "_", value).strip("_")[:96] or "asset"


def now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).isoformat()


def dedupe_messages(values: list[str | None]) -> list[str]:
    output: list[str] = []
    for value in values:
        if not value:
            continue
        if value not in output:
            output.append(value)
    return output


def parse_json_object(content: str) -> dict[str, Any]:
    payload = content.strip()
    if not payload:
        raise HTTPException(status_code=502, detail="Planner returned empty content")

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        start = payload.find("{")
        end = payload.rfind("}")
        if start < 0 or end <= start:
            raise HTTPException(status_code=502, detail="Planner returned invalid JSON")
        try:
            parsed = json.loads(payload[start : end + 1])
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=502, detail=f"Planner returned invalid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="Planner returned a non-object JSON payload")
    return parsed


def compact_concept_phrase(brief: str) -> str:
    normalized = " ".join(brief.strip().split())
    if not normalized:
        return "custom doom asset"

    for pattern in (
        r"(?:into|to|with)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,60})",
        r"(?:sound like|looks like)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,60})",
    ):
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if match:
            candidate = match.group(1).strip(" .,;:!?")
            if candidate:
                return simplify_concept_phrase(candidate)

    return simplify_concept_phrase(normalized)


def simplify_concept_phrase(value: str) -> str:
    candidate = value.strip().lower()
    for separator in (" with ", " and ", " that ", " which ", " while ", ",", ".", ";", ":"):
        if separator in candidate:
            candidate = candidate.split(separator, 1)[0].strip()

    canonical_mappings = (
        ("hamburger", ("hamburger", "burger", "cheeseburger")),
        ("sandwich", ("sandwich", "sub", "hoagie", "panini")),
        ("fish", ("fish", "salmon", "trout", "bass")),
        ("cartoon horn", ("cartoon horn", "horn", "honk")),
    )
    for canonical, aliases in canonical_mappings:
        if any(alias in candidate for alias in aliases):
            return canonical

    candidate = re.sub(r"\b(appearance|style|form|shape|object|graphic|sprite)\b", "", candidate)
    candidate = " ".join(candidate.split())
    return truncate_prompt_words(candidate, 4)


def extract_visual_concept(text: str) -> str:
    normalized = " ".join(text.strip().split())
    if not normalized:
        return "weapon"
    lowered = normalized.lower()
    if "recognizable elements like a gun" in lowered or "like a gun" in lowered:
        return "weapon"

    explicit_patterns = (
        r"(?:into|with|as)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,60})",
        r"(?:turn|replace|swap).{0,40}(?:pistol|gun|weapon|firearm).{0,20}(?:into|with|as)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,60})",
    )
    for pattern in explicit_patterns:
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if match:
            return simplify_concept_phrase(match.group(1))

    canonical = simplify_concept_phrase(normalized)
    if canonical and canonical not in {"recognizable elements like a gun", "gun", "weapon", "pistol"}:
        return canonical
    return "weapon"


def extract_audio_concept(text: str) -> str:
    normalized = " ".join(text.strip().split())
    if not normalized:
        return "custom sound"

    reactive_phrase = extract_reactive_sound_phrase(normalized)
    if reactive_phrase:
        return reactive_phrase

    explicit_patterns = (
        r"(?:which|that|it)\s+([a-z0-9][a-z0-9\s,'\-]{2,80}?)\s+(?:when|on)\s+(?:shot|fired|fire|shooting|triggered|used)",
        r"(?:sound like|sounds like|audio like|sfx like)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,60})",
        r"(?:sound|audio|sfx|noise).{0,20}(?:to|into|with|as)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,60})",
        r"(?:make|turn).{0,30}(?:sound|audio|sfx|noise).{0,20}(?:like|into|with)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s\-]{2,60})",
    )
    for pattern in explicit_patterns:
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if match:
            return simplify_concept_phrase(match.group(1))

    canonical = simplify_concept_phrase(normalized)
    if canonical and canonical not in {"clear", "sound", "audio", "sfx", "noise"}:
        return canonical
    return "custom sound"


def write_asset_audit(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def planner_weapon_brief_has_hybrid_bias(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    hybrid_bias_tokens = (
        "handgun",
        "gun",
        "pistol",
        "firearm",
        "barrel",
        "slide",
        "trigger",
        "receiver",
        "shell",
        "replaceable shell",
        "recognizable elements like a gun",
    )
    return any(token in normalized for token in hybrid_bias_tokens)


def planner_enemy_brief_has_conflicting_weapon_bias(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    return (
        "instead of a gun" in normalized
        or "instead of the gun" in normalized
        or "instead of a pistol" in normalized
        or "instead of the pistol" in normalized
    )


def select_local_asset_brief(kind: str, prompt: str, planner_brief: str) -> str:
    prompt_text = prompt[:240].strip()
    planner_text = planner_brief[:240].strip()
    if not planner_text:
        return prompt_text

    if kind in MVP_IMAGE_KINDS:
        planner_concept = extract_visual_concept(planner_text)
        prompt_concept = extract_visual_concept(prompt_text)
        generic_values = {"weapon"}
        if (
            kind == "weapon_sprite_set"
            and determine_weapon_replacement_mode(prompt_text) != "hybrid"
            and prompt_concept not in generic_values
            and planner_weapon_brief_has_hybrid_bias(planner_text)
        ):
            return prompt_text
        if kind == "enemy_sprite_set" and planner_enemy_brief_has_conflicting_weapon_bias(planner_text):
            return prompt_text
    elif kind in MVP_AUDIO_KINDS:
        planner_concept = extract_audio_concept(planner_text)
        prompt_concept = extract_audio_concept(prompt_text)
        generic_values = {"custom sound"}
    else:
        return planner_text or prompt_text

    if planner_concept in generic_values and prompt_concept not in generic_values:
        return prompt_text
    if len(planner_concept) < len(prompt_concept) and prompt_concept not in generic_values:
        return prompt_text
    return planner_text


def truncate_prompt_words(value: str, max_words: int) -> str:
    words = re.findall(r"[A-Za-z0-9#'\-]+", value)
    if not words:
        return value.strip()
    return " ".join(words[: max(1, max_words)]).strip()


def normalize_plan_object(raw_plan: dict[str, Any], prompt: str) -> dict[str, Any]:
    normalized_prompt = prompt.strip()
    prompt_intent = classify_prompt_intent(normalized_prompt)
    limitations: list[str] = []
    asset_requests, dropped = normalize_asset_requests(
        raw_plan.get("assetRequests"),
        normalized_prompt,
        prompt_intent,
    )
    limitations.extend(dropped)

    if not asset_requests:
        inferred_requests = infer_asset_requests_from_prompt(normalized_prompt, prompt_intent)
        if inferred_requests:
            asset_requests = inferred_requests

    logger.info(
        "plan.normalize intent=%s raw=%s normalized=%s dropped=%s",
        prompt_intent,
        summarize_asset_requests(raw_plan.get("assetRequests")),
        summarize_asset_requests(asset_requests),
        dropped,
    )

    requested_families = raw_plan.get("families")
    families = normalize_families(requested_families, asset_requests)
    if not families and asset_requests:
        families = infer_families_from_assets(asset_requests)

    title = str(raw_plan.get("title") or "").strip()
    if not title:
        title = infer_plan_title(normalized_prompt, asset_requests)
    summary = str(raw_plan.get("summary") or "").strip()
    if not summary:
        summary = infer_plan_summary(asset_requests)

    normalized_plan: dict[str, Any] = {
        "id": str(raw_plan.get("id") or "local-plan").strip() or "local-plan",
        "prompt": normalized_prompt,
        "title": title[:120],
        "summary": summary[:300],
        "status": "planning",
        "families": families,
        "assetRequests": asset_requests,
    }
    if limitations:
        normalized_plan["limitations"] = dedupe_messages(limitations)
    return normalized_plan


def normalize_asset_requests(
    raw_requests: Any,
    prompt: str,
    prompt_intent: str | None = None,
    sound_allowed: bool | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    if not isinstance(raw_requests, list):
        return [], []

    output: list[dict[str, Any]] = []
    dropped: list[str] = []
    seen: set[str] = set()
    prompt_intent = prompt_intent or classify_prompt_intent(prompt)
    sound_allowed = prompt_explicitly_requests_sound(prompt) if sound_allowed is None else sound_allowed

    for item in raw_requests:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip()
        raw_target = str(item.get("target") or "").strip()
        target = canonicalize_target_for_local_mvp(kind, raw_target, prompt)
        brief = str(item.get("brief") or "").strip()
        if not kind or not target:
            continue
        if not brief:
            brief = prompt
        brief = select_local_asset_brief(kind, prompt, brief)

        key = f"{kind}:{target}"
        if key in seen:
            continue

        if prompt_intent == "audio" and kind in MVP_IMAGE_KINDS:
            continue
        if prompt_intent == "visual" and kind in MVP_AUDIO_KINDS:
            continue

        if not is_supported_local_asset_request(kind, target):
            dropped.append(f"Dropped unsupported local target {key}.")
            continue

        if not request_matches_prompt_intent(kind, target, prompt, prompt_intent):
            dropped.append(
                f"Dropped {key} because the prompt did not clearly request that local MVP target."
            )
            continue

        if kind == "sound_pack" and not sound_allowed:
            dropped.append("Dropped sound request because prompt did not explicitly request audio.")
            continue

        if kind in MVP_IMAGE_KINDS:
            output.append(
                {
                    "kind": kind,
                    "target": target,
                    "brief": brief[:240],
                    "frameBudget": "low",
                }
            )
        elif kind in MVP_AUDIO_KINDS:
            output.append({"kind": kind, "target": target, "brief": brief[:240]})
        seen.add(key)

    return output, dropped


def infer_asset_requests_from_prompt(prompt: str, prompt_intent: str | None = None) -> list[dict[str, Any]]:
    normalized = prompt.lower()
    requests: list[dict[str, Any]] = []
    prompt_intent = prompt_intent or classify_prompt_intent(prompt)
    wants_sound = prompt_explicitly_requests_sound(prompt)
    mentions_pistol = prompt_mentions_pistol_target(prompt)
    mentions_zombieman = prompt_mentions_zombieman_target(prompt)
    mentions_doomguy_face = (
        "doomguy" in normalized
        or "status face" in normalized
        or "hud face" in normalized
        or "doom guy face" in normalized
        or "status portrait" in normalized
    )
    visual_intent = any(
        token in normalized for token in ("turn", "swap", "replace", "graphic", "sprite", "look", "into")
    )
    wants_visual = visual_intent or (mentions_pistol and prompt_intent != "audio")

    if prompt_intent in {"visual", "both"} and mentions_pistol and wants_visual:
        requests.append(
            {
                "kind": "weapon_sprite_set",
                "target": "pistol",
                "brief": prompt[:240],
                "frameBudget": "low",
            }
        )

    if prompt_intent in {"visual", "both"} and mentions_zombieman:
        requests.append(
            {
                "kind": "enemy_sprite_set",
                "target": "zombieman",
                "brief": prompt[:240],
                "frameBudget": "low",
            }
        )

    if prompt_intent in {"visual", "both"} and mentions_doomguy_face:
        requests.append(
            {
                "kind": "hud_patch_set",
                "target": "doomguy_face",
                "brief": prompt[:240],
                "frameBudget": "low",
            }
        )

    if prompt_intent in {"audio", "both"} and wants_sound and mentions_pistol:
        requests.append(
            {
                "kind": "sound_pack",
                "target": "pistol",
                "brief": prompt[:240],
            }
        )

    if not requests and mentions_pistol and prompt_intent != "audio":
        requests.append(
            {
                "kind": "weapon_sprite_set",
                "target": "pistol",
                "brief": prompt[:240],
                "frameBudget": "low",
            }
        )

    return requests


def normalize_families(raw_families: Any, asset_requests: list[dict[str, Any]]) -> list[str]:
    allowed = {
        "physics",
        "weapon_behavior",
        "weapon_visual",
        "weapon_audio",
        "enemy_visual",
        "enemy_audio",
        "music",
        "presentation_fx",
    }
    families: list[str] = []
    if isinstance(raw_families, list):
        for value in raw_families:
            family = str(value).strip()
            if family in allowed and family not in families:
                families.append(family)

    for inferred in infer_families_from_assets(asset_requests):
        if inferred not in families:
            families.append(inferred)
    return families


def infer_families_from_assets(asset_requests: list[dict[str, Any]]) -> list[str]:
    inferred: list[str] = []
    for request in asset_requests:
        kind = request.get("kind")
        if kind == "weapon_sprite_set" and "weapon_visual" not in inferred:
            inferred.append("weapon_visual")
        elif kind == "enemy_sprite_set" and "enemy_visual" not in inferred:
            inferred.append("enemy_visual")
        elif kind == "hud_patch_set" and "presentation_fx" not in inferred:
            inferred.append("presentation_fx")
        elif kind == "sound_pack" and "weapon_audio" not in inferred:
            inferred.append("weapon_audio")
    return inferred


def infer_plan_title(prompt: str, asset_requests: list[dict[str, Any]]) -> str:
    if any(request.get("kind") == "weapon_sprite_set" for request in asset_requests):
        return "Local MVP weapon swap"
    if any(request.get("kind") == "enemy_sprite_set" for request in asset_requests):
        return "Local MVP enemy swap"
    return f"Local MVP mod: {' '.join(prompt.split()[:4])}".strip()[:120]


def infer_plan_summary(asset_requests: list[dict[str, Any]]) -> str:
    if not asset_requests:
        return "No supported local MVP asset requests were inferred from the prompt."
    parts = [f"{request['kind']}:{request['target']}" for request in asset_requests]
    return f"Applying local MVP asset requests: {', '.join(parts)}."


GENERIC_AUDIO_CUE_TERMS = (
    "audio",
    "sound",
    "sfx",
    "voice",
    "noise",
    "music",
    "soundtrack",
    "song",
    "track",
    "silent",
    "mute",
    "quiet",
)
REACTIVE_VISUAL_TERMS = (
    "glow",
    "glows",
    "flash",
    "flashes",
    "sparkle",
    "sparkles",
    "shine",
    "shines",
    "glitter",
    "glitters",
    "light up",
    "lights up",
    "pulse",
    "pulses",
    "vibrate",
    "vibrates",
    "wiggle",
    "wiggles",
    "open",
    "opens",
)


def extract_reactive_sound_phrase(text: str) -> str | None:
    normalized = " ".join(text.strip().split())
    if not normalized:
        return None

    patterns = (
        r"\b(?:which|that|it)\s+([a-z0-9][a-z0-9\s,'\-]{2,80}?)\s+(?:when|whenever|on|every time)\s+(?:shot|fired|fire|shooting|triggered|used)\b",
        r"\b(?:when|whenever|on|every time)\s+(?:shot|fired|fire|shooting|triggered|used)\b.{0,20}\b(?:it|this|that)\s+(?:makes?|does|goes?|lets? out|plays?|emits?)\s+([a-z0-9][a-z0-9\s,'\-]{2,80}?)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if not match:
            continue
        raw_candidate = re.sub(
            r"^(?:makes?|does|goes?|lets?\s+out|plays?|emits?)\s+(?:a\s+|an\s+|the\s+)?",
            "",
            match.group(1).strip(),
            flags=re.IGNORECASE,
        )
        candidate = simplify_concept_phrase(raw_candidate)
        if not candidate:
            continue
        if any(token in candidate for token in REACTIVE_VISUAL_TERMS):
            continue
        if candidate in {"turn", "replace", "swap", "transform"}:
            continue
        return candidate
    return None


def prompt_explicitly_requests_sound(prompt: str) -> bool:
    normalized = prompt.lower()
    if any(token in normalized for token in GENERIC_AUDIO_CUE_TERMS):
        return True
    if extract_reactive_sound_phrase(prompt):
        return True
    generic_audio_patterns = (
        r"\b(?:sound|audio|sfx|noise|voice)\s+like\s+([a-z0-9][a-z0-9\s,'\-]{1,80})\b",
        r"\b(?:make|turn|have)\b.{0,24}\b(?:it|this|that|the\s+\w+)?\b.{0,24}\b(?:sound|audio|sfx|noise|voice)\b.{0,24}\b(?:like|as)\s+([a-z0-9][a-z0-9\s,'\-]{1,80})\b",
        r"\b(?:replace|swap|change)\b.{0,24}\b(?:the\s+)?(?:sound|audio|sfx|noise)\b.{0,24}\b(?:with|to)\s+([a-z0-9][a-z0-9\s,'\-]{1,80})\b",
    )
    if any(re.search(pattern, normalized) for pattern in generic_audio_patterns):
        return True
    if re.search(r"\b(?:when|on)\s+(?:shot|fired|fire|shooting|triggered|used)\b.{0,20}\b(?:make|emit|play)\b.{0,20}\b(?:audio|sound|sfx|noise)\b", normalized):
        return True
    return False


def prompt_explicitly_requests_visual(prompt: str) -> bool:
    normalized = prompt.lower()
    has_visual_tokens = any(
        token in normalized
        for token in (
            "graphic",
            "sprite",
            "visual",
            "look",
            "appearance",
            "skin",
            "texture",
            "model",
            "into",
            "turn",
        )
    )
    has_swap_tokens = "swap" in normalized or "replace" in normalized
    has_sound_tokens = prompt_explicitly_requests_sound(prompt)
    has_targeted_visual_swap = bool(
        re.search(r"(swap|replace|turn).{0,40}(pistol|gun|weapon|firearm).{0,40}(with|into)", normalized)
    )
    if has_visual_tokens:
        return True
    if has_targeted_visual_swap:
        return True
    if has_swap_tokens and not has_sound_tokens:
        return True
    return False


def classify_prompt_intent(prompt: str) -> str:
    normalized = prompt.lower()
    wants_sound = prompt_explicitly_requests_sound(prompt)
    wants_visual = prompt_explicitly_requests_visual(prompt)

    mentions_game_targets = any(
        token in normalized
        for token in ("pistol", "gun", "weapon", "firearm", "zombie", "zombieman")
    )
    if not wants_sound and mentions_game_targets:
        wants_visual = True

    if wants_sound and wants_visual:
        return "both"
    if wants_sound:
        return "audio"
    return "visual"


def summarize_asset_requests(raw_requests: Any) -> list[str]:
    if not isinstance(raw_requests, list):
        return []
    summary: list[str] = []
    for item in raw_requests:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip()
        target = str(item.get("target") or "").strip()
        if kind and target:
            summary.append(f"{kind}:{target}")
    return summary[:20]


def request_matches_prompt_intent(kind: str, target: str, prompt: str, prompt_intent: str | None = None) -> bool:
    prompt_intent = prompt_intent or classify_prompt_intent(prompt)
    mentions_pistol = prompt_mentions_pistol_target(prompt)
    mentions_zombieman = prompt_mentions_zombieman_target(prompt)
    normalized = prompt.lower()
    mentions_doomguy_face = (
        "doomguy" in normalized
        or "status face" in normalized
        or "hud face" in normalized
        or "doom guy face" in normalized
        or "status portrait" in normalized
    )
    visual_intent = prompt_explicitly_requests_visual(prompt)

    if kind == "weapon_sprite_set" and target == "pistol":
        return prompt_intent in {"visual", "both"} and mentions_pistol and (visual_intent or prompt_intent == "visual")
    if kind == "enemy_sprite_set" and target == "zombieman":
        return prompt_intent in {"visual", "both"} and mentions_zombieman
    if kind == "hud_patch_set" and target == "doomguy_face":
        return prompt_intent in {"visual", "both"} and mentions_doomguy_face
    if kind == "sound_pack" and target == "pistol":
        return prompt_intent in {"audio", "both"} and mentions_pistol and prompt_explicitly_requests_sound(prompt)
    return False


def canonicalize_target_for_local_mvp(kind: str, target: str, prompt: str) -> str:
    normalized_target = target.strip().lower()
    normalized_prompt = prompt.lower()

    if kind in {"weapon_sprite_set", "sound_pack"}:
        if "pistol" in normalized_target:
            return "pistol"
        if prompt_mentions_pistol_target(prompt):
            return "pistol"

    if kind == "enemy_sprite_set":
        if "zombieman" in normalized_target or "zombie" in normalized_target:
            return "zombieman"
        if prompt_mentions_zombieman_target(prompt):
            return "zombieman"

    if kind == "hud_patch_set":
        if "doomguy_face" in normalized_target or "doomguy" in normalized_target:
            return "doomguy_face"
        if (
            "doomguy" in normalized_prompt
            or "status face" in normalized_prompt
            or "hud face" in normalized_prompt
            or "doom guy face" in normalized_prompt
        ):
            return "doomguy_face"

    return normalized_target


def prompt_mentions_pistol_target(prompt: str) -> bool:
    normalized = prompt.lower()
    explicit_player_weapon_patterns = (
        r"\b(?:turn|transform|swap|replace|change|make)\b.{0,40}\b(?:the\s+)?pistol\b",
        r"\b(?:turn|transform|swap|replace|change|make)\b.{0,40}\b(?:the\s+)?(?:player'?s?\s+)?(?:gun|weapon|firearm|sidearm)\b",
        r"\b(?:make|have)\b.{0,24}\b(?:the\s+)?pistol\b.{0,24}\b(?:sound|look|become|turn|transform)\b",
        r"\b(?:the\s+)?pistol\b.{0,40}\b(?:into|with|as|become|look like|sound like|sound)\b",
        r"\b(?:player'?s?\s+)?(?:gun|weapon|firearm|sidearm)\b.{0,40}\b(?:into|with|as|become|look like|sound like)\b",
    )
    if any(re.search(pattern, normalized) for pattern in explicit_player_weapon_patterns):
        return True
    if prompt_mentions_zombieman_target(prompt) and prompt_has_enemy_scoped_pistol_mention(normalized):
        return False
    return False


def prompt_has_enemy_scoped_pistol_mention(normalized_prompt: str) -> bool:
    enemy_scoped_patterns = (
        r"\b(?:zombieman|zombie man|zombie)\b.{0,180}\b(?:with|holding|wielding|carrying|armed with|using|instead of|and)\s+(?:a|an|the)?\s*pistol\b",
        r"\b(?:with|holding|wielding|carrying|armed with|using|instead of|and)\s+(?:a|an|the)?\s*pistol\b.{0,120}\b(?:zombieman|zombie man|zombie)\b",
    )
    return any(re.search(pattern, normalized_prompt) for pattern in enemy_scoped_patterns)


def prompt_mentions_zombieman_target(prompt: str) -> bool:
    normalized = prompt.lower()
    if "zombieman" in normalized or "zombie man" in normalized:
        return True
    enemy_patterns = (
        r"(?:turn|transform|swap|replace|change|make).{0,40}\bzombie\b",
        r"\bzombie\b.{0,40}(?:into|with|as|become)\b",
    )
    return any(re.search(pattern, normalized) for pattern in enemy_patterns)


def is_supported_local_asset_request(kind: str, target: str) -> bool:
    if kind == "weapon_sprite_set":
        return target in MVP_WEAPON_TARGETS
    if kind == "enemy_sprite_set":
        return target in MVP_ENEMY_TARGETS
    if kind == "hud_patch_set":
        return target in MVP_HUD_TARGETS
    return False


def is_configured_secret(value: str | None) -> bool:
    candidate = str(value or "").strip()
    if not candidate:
        return False
    return not re.match(r"^YOUR_[A-Z0-9_]+_HERE$", candidate, flags=re.IGNORECASE)


def has_openai_planner_config() -> bool:
    return bool(OPENAI_BASE_URL) and is_configured_secret(OPENAI_API_KEY)


def resolve_planner_backend(requested_model: str | None = None) -> str:
    model_candidate = str(requested_model or "").strip().lower()
    if model_candidate:
        if ":" in model_candidate:
            return "ollama"
        if model_candidate.startswith("gpt-") or model_candidate.startswith("o1") or model_candidate.startswith("o3") or model_candidate.startswith("o4"):
            if has_openai_planner_config():
                return "openai"
            return "ollama"
    if PREFER_OPENAI_PLANNER and has_openai_planner_config():
        return "openai"
    return "ollama"


def resolve_openai_model(requested_model: str | None) -> str:
    candidate = str(requested_model or "").strip()
    if not candidate:
        return OPENAI_PLANNER_MODEL
    normalized = candidate.lower()
    if ":" in normalized:
        return OPENAI_PLANNER_MODEL
    if normalized.startswith("gpt-") or normalized.startswith("o1") or normalized.startswith("o3") or normalized.startswith("o4"):
        return candidate
    return OPENAI_PLANNER_MODEL


async def check_planner_health() -> tuple[bool, str | None, str, str | None, bool]:
    planner_backend = resolve_planner_backend()
    if planner_backend == "openai":
        if not has_openai_planner_config():
            state.planner_status = "error"
            state.planner_error_message = "OpenAI planner is not configured"
            return False, state.planner_error_message, "openai", OPENAI_PLANNER_MODEL, False
        state.planner_status = "ready"
        state.planner_error_message = None
        return True, None, "openai", OPENAI_PLANNER_MODEL, False

    planner_ok, planner_error = await check_ollama()
    return planner_ok, planner_error, "ollama", OLLAMA_MODEL, state.planner_status == "ready"


async def run_planner(prompt: str, requested_model: str | None, planner_backend: str) -> dict[str, Any]:
    if planner_backend == "openai":
        return await run_openai_planner(prompt, requested_model)
    return await run_ollama_planner(prompt, requested_model)


async def run_openai_planner(prompt: str, requested_model: str | None) -> dict[str, Any]:
    if not has_openai_planner_config():
        state.planner_status = "error"
        state.planner_error_message = "OpenAI planner is not configured"
        raise HTTPException(status_code=503, detail=state.planner_error_message)

    model = resolve_openai_model(requested_model)
    request_body = {
        "model": model,
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{OPENAI_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json=request_body,
        )
    if response.status_code >= 400:
        state.planner_status = "error"
        state.planner_error_message = f"OpenAI planner failed ({response.status_code})"
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI planner failed ({response.status_code}): {response.text[:220]}",
        )
    data = response.json()
    choices = data.get("choices") if isinstance(data, dict) else None
    content = ""
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {})
        if isinstance(message, dict):
            content = str(message.get("content") or "")
    if not content:
        state.planner_status = "error"
        state.planner_error_message = "OpenAI planner returned no content"
        raise HTTPException(status_code=502, detail=state.planner_error_message)

    plan_obj = parse_json_object(content)
    state.planner_status = "ready"
    state.planner_error_message = None
    return normalize_plan_object(plan_obj, prompt)


async def run_ollama_planner(prompt: str, requested_model: str | None) -> dict[str, Any]:
    planner_ok, planner_error = await check_ollama()
    if not planner_ok:
        raise HTTPException(status_code=503, detail=f"Ollama unavailable: {planner_error}")

    model = requested_model.strip() if requested_model else OLLAMA_MODEL
    if not model:
        model = OLLAMA_MODEL

    request_body = {
        "model": model,
        "stream": False,
        "format": "json",
        "messages": [
            {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=request_body)
    if response.status_code >= 400:
        state.planner_status = "error"
        state.planner_error_message = f"Ollama planner failed ({response.status_code})"
        raise HTTPException(
            status_code=502,
            detail=f"Ollama planner failed ({response.status_code}): {response.text[:220]}",
        )

    data = response.json()
    content = data.get("message", {}).get("content", "") if isinstance(data, dict) else ""
    if not content:
        state.planner_status = "error"
        state.planner_error_message = "Ollama planner returned no content"
        raise HTTPException(status_code=502, detail=state.planner_error_message)

    plan_obj = parse_json_object(content)
    state.planner_status = "ready"
    state.planner_error_message = None
    return normalize_plan_object(plan_obj, prompt)


async def check_ollama() -> tuple[bool, str | None]:
    if not OLLAMA_BASE_URL:
        return False, "DOOMGEN_OLLAMA_BASE_URL is empty"
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            response = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
        if response.status_code >= 400:
            state.planner_status = "error"
            state.planner_error_message = f"/api/tags failed with status {response.status_code}"
            return False, f"/api/tags failed with status {response.status_code}"
        if state.planner_status == "idle":
            state.planner_status = "available"
            state.planner_error_message = None
        return True, None
    except Exception as exc:  # pragma: no cover - host dependent
        state.planner_status = "error"
        state.planner_error_message = str(exc)
        return False, str(exc)


async def warm_planner_model(requested_model: str | None = None) -> None:
    planner_backend = resolve_planner_backend(requested_model)
    if planner_backend == "openai":
        if not has_openai_planner_config():
            state.planner_status = "error"
            state.planner_error_message = "OpenAI planner is not configured"
            raise RuntimeError(state.planner_error_message)
        state.planner_status = "ready"
        state.planner_error_message = None
        state.planner_last_warm_at = time.monotonic()
        return

    planner_ok, planner_error = await check_ollama()
    if not planner_ok:
        raise RuntimeError(planner_error or "Ollama unavailable")

    request_body = {
        "model": OLLAMA_MODEL,
        "prompt": "ping",
        "stream": False,
        "keep_alive": "30m",
        "options": {
            "num_predict": 1,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{OLLAMA_BASE_URL}/api/generate", json=request_body)
        if response.status_code >= 400:
            state.planner_status = "error"
            state.planner_error_message = f"Ollama warmup failed ({response.status_code}): {response.text[:220]}"
            raise RuntimeError(state.planner_error_message)
        state.planner_status = "ready"
        state.planner_error_message = None
        state.planner_last_warm_at = time.monotonic()
    except Exception as exc:
        state.planner_status = "error"
        state.planner_error_message = str(exc) if str(exc) else exc.__class__.__name__
        raise


def can_serve_images() -> tuple[bool, str | None]:
    if not IMAGE_MODEL_ID:
        return False, "DOOMGEN_IMAGE_MODEL_ID is empty"
    try:
        import diffusers  # noqa: F401
        import torch  # noqa: F401
        return True, None
    except Exception as exc:  # pragma: no cover - environment dependent
        return False, str(exc)


def describe_sfx_readiness() -> tuple[str | None, str]:
    return "provider_routed", "disabled"


def set_sfx_readiness(status: str, category: str | None, message: str | None) -> None:
    state.sfx_backend_status = status
    state.sfx_backend_error_category = category
    state.sfx_backend_error_message = (message or "").strip() or None
    state.sfx_backend_last_probe_at = time.monotonic()


async def can_serve_sfx() -> tuple[bool, str | None, str | None]:
    return False, "Local SFX generation is disabled; sound packs use the ElevenLabs provider path.", "provider_routed"


async def ensure_sfx_readiness() -> tuple[bool, str | None, str | None]:
    set_sfx_readiness(
        SFX_READINESS_STATUS_BLOCKED,
        "provider_routed",
        "Local SFX generation is disabled; sound packs use the ElevenLabs provider path.",
    )
    return False, state.sfx_backend_error_message, state.sfx_backend_error_category


async def _probe_sfx_backend() -> None:
    raise RuntimeError("Local SFX generation is disabled; sound packs use the ElevenLabs provider path.")


def choose_torch_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def choose_torch_dtype(device: str):
    import torch

    if device in {"cuda", "mps"}:
        return torch.float16
    return torch.float32


async def ensure_image_pipeline() -> None:
    if state.image_pipeline is not None:
        return

    if not state.keep_models_loaded:
        await unload_sfx_backends()

    try:
        import torch
        from diffusers import AutoPipelineForText2Image, Flux2KleinPipeline, LCMScheduler

        device = choose_torch_device()
        dtype = choose_torch_dtype(device)
        is_flux2_klein = "flux.2-klein" in IMAGE_MODEL_ID.lower()
        if is_flux2_klein:
            pipe = Flux2KleinPipeline.from_pretrained(
                IMAGE_MODEL_ID,
                torch_dtype=dtype,
            )
        else:
            pipe = AutoPipelineForText2Image.from_pretrained(
                IMAGE_MODEL_ID,
                torch_dtype=dtype,
                safety_checker=None,
                requires_safety_checker=False,
            )
            if IMAGE_LORA_ID:
                try:
                    pipe.load_lora_weights(IMAGE_LORA_ID)
                    pipe.fuse_lora()
                    pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
                except Exception:
                    logger.warning(
                        "image.pipeline.lora_disabled lora=%s reason=load_failed (continuing without lora)",
                        IMAGE_LORA_ID,
                    )

        pipe.set_progress_bar_config(disable=True)
        pipe.to(device)
        state.image_pipeline = pipe
        state.active_image_backend = f"diffusers:{'flux2_klein' if is_flux2_klein else 'text2img'}:{IMAGE_MODEL_ID}"
    except Exception as exc:  # pragma: no cover - environment dependent
        state.image_pipeline = None
        state.active_image_backend = "error"
        logger.exception("image.pipeline.init_failed model=%s lora=%s", IMAGE_MODEL_ID, IMAGE_LORA_ID)
        raise HTTPException(status_code=503, detail=f"Failed to initialize image pipeline: {exc}") from exc


async def unload_image_pipeline() -> None:
    if state.image_pipeline is None:
        return
    state.image_pipeline = None
    state.active_image_backend = "idle"
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


async def run_image_generation(
    prompt: str,
    *,
    source_image: Image.Image | None = None,
    steps_override: int | None = None,
    guidance_override: float | None = None,
    strength_override: float | None = None,
):
    pipe = state.image_pipeline
    if pipe is None:
        raise HTTPException(status_code=503, detail="Image pipeline is not initialized")
    steps = max(1, int(steps_override)) if steps_override is not None else IMAGE_STEPS
    guidance = float(guidance_override) if guidance_override is not None else IMAGE_GUIDANCE_SCALE

    def _run():
        if "flux2_klein" in state.active_image_backend:
            kwargs: dict[str, Any] = {
                "prompt": prompt,
                "width": 512,
                "height": 512,
                "num_inference_steps": steps,
                "guidance_scale": guidance,
            }
            if source_image is not None:
                kwargs["image"] = source_image.convert("RGB").resize((512, 512), Image.Resampling.BICUBIC)
            if source_image is not None and strength_override is not None:
                strength_value = max(0.0, min(1.0, float(strength_override)))
                kwargs_with_strength = dict(kwargs)
                kwargs_with_strength["strength"] = strength_value
                try:
                    result = pipe(**kwargs_with_strength)
                except TypeError:
                    result = pipe(**kwargs)
            else:
                result = pipe(**kwargs)
        else:
            result = pipe(
                prompt=prompt,
                negative_prompt=(
                    "person, human, humanoid, face, head, torso, enemy, monster, creature, room, wall, floor, "
                    "background, full scene, third person, side view, grayscale, monochrome, sketch, line art, "
                    "wireframe, text, watermark, logo, blurry background"
                ),
                width=512,
                height=512,
                num_inference_steps=steps,
                guidance_scale=guidance,
            )
        return result.images[0]

    try:
        return await asyncio.to_thread(_run)
    except Exception as exc:
        logger.exception("image.generation.failed prompt_preview=%s", prompt[:120])
        raise


def try_remove_background(image):
    if not USE_REM_BG:
        return postprocess_sprite_image(image.convert("RGBA"))
    try:
        from rembg import remove

        source = io.BytesIO()
        image.save(source, format="PNG")
        output = remove(
            source.getvalue(),
            alpha_matting=True,
            alpha_matting_foreground_threshold=235,
            alpha_matting_background_threshold=8,
            alpha_matting_erode_size=8,
        )
        return postprocess_sprite_image(Image.open(io.BytesIO(output)).convert("RGBA"))
    except Exception:
        return postprocess_sprite_image(image.convert("RGBA"))


def postprocess_sprite_image(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    rgba = ImageEnhance.Color(rgba).enhance(1.18)
    rgba = ImageEnhance.Contrast(rgba).enhance(1.08)

    data = np.array(rgba, dtype=np.uint8)
    alpha = data[:, :, 3]
    low_alpha = alpha < 64
    data[low_alpha, 0] = 0
    data[low_alpha, 1] = 0
    data[low_alpha, 2] = 0
    alpha[low_alpha] = 0

    soft_edge = (alpha >= 64) & (alpha < 120)
    alpha[soft_edge] = np.asarray(alpha[soft_edge] * 0.75, dtype=np.uint8)

    green_spill = (
        (data[:, :, 1] > 132)
        & (data[:, :, 1] > data[:, :, 0] + 32)
        & (data[:, :, 1] > data[:, :, 2] + 32)
        & (alpha < 220)
    )
    alpha[green_spill] = np.minimum(alpha[green_spill], 44)

    data[:, :, 3] = alpha
    return Image.fromarray(data, mode="RGBA")


async def run_sfx_generation(
    prompt: str,
    duration_seconds: float,
    kind: str,
) -> tuple[np.ndarray, int]:
    raise RuntimeError("Local SFX generation is disabled; sound packs use the ElevenLabs provider path.")


def classify_sfx_error(error: Exception) -> tuple[str, str]:
    return "provider_routed", "Local SFX generation is disabled; sound packs use the ElevenLabs provider path."


async def unload_sfx_backends() -> None:
    state.sfx_pipeline = None
    state.active_sfx_backend = "idle"


def normalize_audio(samples: Any, sample_rate: int, profile: dict[str, Any]) -> np.ndarray:
    if not isinstance(samples, np.ndarray):
        raise RuntimeError("Audio generation returned invalid sample array")

    if samples.size == 0:
        raise RuntimeError("Audio generation returned no samples")
    if not np.all(np.isfinite(samples)):
        raise RuntimeError("Audio generation returned non-finite sample values")

    samples_array = np.asarray(samples, dtype=np.float32)
    if samples_array.ndim == 1:
        mono = samples_array
    elif samples_array.ndim == 2:
        if samples_array.shape[0] <= samples_array.shape[1]:
            mono = samples_array.mean(axis=0)
        else:
            mono = samples_array.mean(axis=1)
    else:
        squeezed = np.squeeze(samples_array)
        if squeezed.ndim == 1:
            mono = squeezed
        elif squeezed.ndim == 2:
            if squeezed.shape[0] <= squeezed.shape[1]:
                mono = squeezed.mean(axis=0)
            else:
                mono = squeezed.mean(axis=1)
        else:
            raise RuntimeError("Audio generation returned unsupported sample dimensions")

    mono = np.asarray(mono, dtype=np.float32).reshape(-1)
    if mono.size == 0:
        raise RuntimeError("Audio generation returned empty sample array")

    if not np.all(np.isfinite(mono)):
        raise RuntimeError("Audio generation returned invalid sample values")

    effective_sample_rate = int(sample_rate)
    if effective_sample_rate <= 0:
        raise RuntimeError("Audio generation returned invalid sample rate")

    requested_duration = float(profile.get("duration_seconds", 4.0))
    min_duration = float(profile.get("min_duration_seconds", 0.5))
    max_duration = float(profile.get("max_duration_seconds", 24.0))
    fade_seconds = float(profile.get("fade_seconds", 0.01))

    if min_duration < 0 or max_duration <= 0 or max_duration < min_duration:
        min_duration = 0.5
        max_duration = 24.0
    clamped_duration = clamp(requested_duration, min_duration, max_duration)
    target_samples = int(round(max(0.0, clamped_duration) * effective_sample_rate))
    if target_samples < 1:
        raise RuntimeError("Audio generation request duration is too short")

    if mono.size > target_samples:
        mono = mono[:target_samples]
    elif mono.size < target_samples:
        mono = np.pad(mono, (0, target_samples - mono.size), mode="constant")

    peak = float(np.max(np.abs(mono)))
    if peak <= 0.0 or not np.isfinite(peak):
        raise RuntimeError("Audio generation produced only silence")

    mono = mono - float(mono.mean())
    fade_samples = min(int(effective_sample_rate * fade_seconds), mono.size // 2)
    if fade_samples > 0:
        fade = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
        mono[:fade_samples] *= fade
        mono[-fade_samples:] *= fade[::-1]

    mono = np.clip(mono / peak, -1.0, 1.0)
    return np.asarray((mono * 32767.0 * 0.9).clip(-32767.0, 32767.0), dtype=np.int16)


def clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min(value, max_value), min_value)


def write_wav_pcm16(path: Path, sample_rate: int, pcm_mono: np.ndarray) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(int(sample_rate))
        wav_file.writeframes(pcm_mono.tobytes())
