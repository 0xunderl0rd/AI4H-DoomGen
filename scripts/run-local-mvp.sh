#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$ROOT_DIR/local-doomgen-service"
SERVICE_VENV_DIR="$SERVICE_DIR/.venv"
SERVICE_REQUIREMENTS="$SERVICE_DIR/requirements.txt"
SERVICE_URL="http://127.0.0.1:8000"
OLLAMA_URL="http://127.0.0.1:11434"
PLANNER_MODEL="${DOOMGEN_LOCAL_PLANNER_MODEL:-qwen2.5:1.5b}"
SERVICE_LOG_FILE="${DOOMGEN_LOCAL_SERVICE_LOG:-$ROOT_DIR/.tmp/local-service.log}"
OLLAMA_LOG_FILE="${DOOMGEN_OLLAMA_LOG:-$ROOT_DIR/.tmp/ollama.log}"
SERVICE_PYTHON=""

SERVICE_PID=""
OLLAMA_PID=""

log() {
  printf '[local-mvp] %s\n' "$*"
}

ensure_hf_token_aliases() {
  if [[ -n "${HF_TOKEN:-}" && -z "${HUGGING_FACE_HUB_TOKEN:-}" ]]; then
    export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"
  fi
  if [[ -n "${HUGGING_FACE_HUB_TOKEN:-}" && -z "${HF_TOKEN:-}" ]]; then
    export HF_TOKEN="$HUGGING_FACE_HUB_TOKEN"
  fi
}

is_placeholder_secret() {
  local value="${1:-}"
  [[ -z "$value" || "$value" =~ ^YOUR_[A-Z0-9_]+_HERE$ ]]
}

resolve_openai_planner_key() {
  local value="${DOOMGEN_OPENAI_API_KEY:-${VITE_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}}"
  printf '%s' "$value"
}

has_openai_planner_config() {
  local key
  key="$(resolve_openai_planner_key)"
  if is_placeholder_secret "$key"; then
    return 1
  fi
  return 0
}

planner_model_looks_local() {
  local model="${1:-}"
  [[ "$model" == *:* ]]
}

resolve_openai_planner_model() {
  local model="${DOOMGEN_OPENAI_MODEL:-${VITE_OPENAI_MODEL:-gpt-4.1-mini}}"
  printf '%s' "$model"
}

load_env_file() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

canonical_path() {
  if [[ -z "${1:-}" ]]; then
    return 0
  fi
  python3 - <<'PY' "$1"
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing required command: $1"
    exit 1
  fi
}

python_major_minor() {
  local py_cmd="$1"
  "$py_cmd" - <<'PY'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY
}

version_to_int() {
  local version="$1"
  local major="${version%%.*}"
  local minor="${version##*.}"
  printf '%d' "$((major * 100 + minor))"
}

resolve_service_python() {
  local requested="${DOOMGEN_LOCAL_PYTHON:-}"
  local candidates=()
  local py_cmd
  local version
  local version_int

  if [[ -n "$requested" ]]; then
    candidates+=("$requested")
  else
    candidates+=(python3.13 python3.12 python3.11 python3.10 python3)
  fi

  for py_cmd in "${candidates[@]}"; do
    if ! command -v "$py_cmd" >/dev/null 2>&1; then
      continue
    fi
    version="$(python_major_minor "$py_cmd" 2>/dev/null || true)"
    if [[ -z "$version" ]]; then
      continue
    fi
    version_int="$(version_to_int "$version")"
    if (( version_int >= 310 && version_int <= 313 )); then
      SERVICE_PYTHON="$py_cmd"
      log "Using Python interpreter for local service: $py_cmd (v$version)"
      return 0
    fi
  done

  log "No compatible Python interpreter found for local service (requires 3.10-3.13)."
  if [[ -n "$requested" ]]; then
    log "Requested via DOOMGEN_LOCAL_PYTHON=$requested but it is unavailable or incompatible."
  fi
  log "Install one of: python3.11, python3.12, or python3.13 (recommended python3.13 if already present)."
  log "Then rerun with: DOOMGEN_LOCAL_PYTHON=python3.13 npm run dev:local-mvp"
  exit 1
}

cleanup() {
  local exit_code=$?
  if [[ -n "$SERVICE_PID" ]]; then
    log "Stopping local service (pid=$SERVICE_PID)"
    kill "$SERVICE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$OLLAMA_PID" ]]; then
    log "Stopping ollama serve (pid=$OLLAMA_PID)"
    kill "$OLLAMA_PID" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local max_attempts="${3:-40}"
  local attempt
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  log "Timed out waiting for $label at $url"
  return 1
}

ensure_ollama_running() {
  if curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    log "Ollama is already running."
    return 0
  fi

  log "Ollama API is not reachable; starting ollama serve in background."
  mkdir -p "$ROOT_DIR/.tmp"
  nohup ollama serve >"$OLLAMA_LOG_FILE" 2>&1 &
  OLLAMA_PID="$!"
  wait_for_url "$OLLAMA_URL/api/tags" "Ollama API"
  log "Ollama started (pid=$OLLAMA_PID, log=$OLLAMA_LOG_FILE)."
}

ensure_ollama_model() {
  if ollama list | awk 'NR>1 {print $1}' | grep -Fx "$PLANNER_MODEL" >/dev/null 2>&1; then
    log "Planner model already available: $PLANNER_MODEL"
    return 0
  fi

  log "Pulling missing planner model: $PLANNER_MODEL"
  ollama pull "$PLANNER_MODEL"
}

ensure_service_venv() {
  local recreate="false"
  local existing_version=""
  local existing_version_int=0

  if [[ ! -d "$SERVICE_DIR" ]]; then
    log "Missing local service directory: $SERVICE_DIR"
    exit 1
  fi
  if [[ ! -f "$SERVICE_REQUIREMENTS" ]]; then
    log "Missing requirements file: $SERVICE_REQUIREMENTS"
    exit 1
  fi
  if [[ ! -d "$SERVICE_VENV_DIR" ]] || [[ ! -x "$SERVICE_VENV_DIR/bin/python" ]]; then
    recreate="true"
  else
    existing_version="$("$SERVICE_VENV_DIR/bin/python" - <<'PY'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY
)"
    existing_version_int="$(version_to_int "$existing_version")"
    if (( existing_version_int < 310 || existing_version_int > 313 )); then
      recreate="true"
      log "Existing local service venv uses incompatible Python v$existing_version; recreating."
    fi
  fi

  if [[ "$recreate" == "true" ]]; then
    rm -rf "$SERVICE_VENV_DIR"
    log "Creating local service virtualenv at $SERVICE_VENV_DIR"
    "$SERVICE_PYTHON" -m venv "$SERVICE_VENV_DIR"
  fi
}

report_venv_context() {
  local active="${VIRTUAL_ENV:-}"
  local active_real=""
  local service_real=""
  active_real="$(canonical_path "$active")"
  service_real="$(canonical_path "$SERVICE_VENV_DIR")"

  if [[ -z "$active" ]]; then
    log "No active shell venv detected; runner will use $SERVICE_VENV_DIR."
    return 0
  fi

  if [[ -n "$active_real" ]] && [[ "$active_real" == "$service_real" ]]; then
    log "Detected active local service venv: $active_real"
    return 0
  fi

  log "Detected different active venv: $active"
  log "Isolating installs to $SERVICE_VENV_DIR only (no global/site install)."
}

install_service_dependencies() {
  local stamp_file="$SERVICE_VENV_DIR/.doomgen_requirements.sha256"
  local current_hash
  current_hash="$(shasum -a 256 "$SERVICE_REQUIREMENTS" | awk '{print $1}')"
  if [[ -f "$stamp_file" ]] && [[ "$(cat "$stamp_file")" == "$current_hash" ]]; then
    log "Local service dependencies already up to date."
    return 0
  fi

  log "Installing local service dependencies..."
  "$SERVICE_VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null
  if ! "$SERVICE_VENV_DIR/bin/pip" install -r "$SERVICE_REQUIREMENTS"; then
    log "Dependency installation failed."
    log "If this is a torch wheel availability issue on your Python version, try:"
    log "  DOOMGEN_LOCAL_PYTHON=python3.12 npm run dev:local-mvp"
    log "Or inspect pip resolver output above for the exact conflicting package."
    return 1
  fi
  printf '%s' "$current_hash" >"$stamp_file"
}

start_local_service() {
  mkdir -p "$ROOT_DIR/.tmp"
  local image_model="${DOOMGEN_IMAGE_MODEL_ID:-black-forest-labs/FLUX.2-klein-4B}"
  local image_steps="${DOOMGEN_IMAGE_STEPS:-4}"
  local image_guidance="${DOOMGEN_IMAGE_GUIDANCE:-1.0}"
  local openai_key
  local openai_model
  openai_model="$(resolve_openai_planner_model)"
  openai_key="$(resolve_openai_planner_key)"
  log "Local image backend: $image_model (steps=$image_steps guidance=$image_guidance)"
  log "Audio provider: ElevenLabs (frontend/provider path)"
  if has_openai_planner_config; then
    log "Planner backend: OpenAI ($openai_model)"
  else
    log "Planner backend: Ollama ($PLANNER_MODEL)"
  fi
  log "Starting local DoomGen service..."
  (
    cd "$SERVICE_DIR"
    HF_TOKEN="${HF_TOKEN:-}" \
      HUGGING_FACE_HUB_TOKEN="${HUGGING_FACE_HUB_TOKEN:-}" \
    DOOMGEN_OPENAI_API_KEY="$openai_key" \
      DOOMGEN_OPENAI_MODEL="$openai_model" \
    DOOMGEN_OLLAMA_MODEL="$PLANNER_MODEL" \
    DOOMGEN_IMAGE_MODEL_ID="$image_model" \
      DOOMGEN_IMAGE_STEPS="$image_steps" \
    DOOMGEN_IMAGE_GUIDANCE="$image_guidance" \
      "$SERVICE_VENV_DIR/bin/uvicorn" app.main:app --host 127.0.0.1 --port 8000 --reload --log-level info
  ) >"$SERVICE_LOG_FILE" 2>&1 &
  SERVICE_PID="$!"

  wait_for_url "$SERVICE_URL/v1/health" "local service health endpoint"
  log "Local service is ready (pid=$SERVICE_PID, log=$SERVICE_LOG_FILE)."
}

check_wad() {
  local wad_file="$ROOT_DIR/public/doom/doom1.wad"
  if [[ ! -f "$wad_file" ]]; then
    log "WARNING: Missing $wad_file"
    log "Run ./scripts/build-doom-wasm.sh doom_wads/DOOM1.WAD if Doom does not boot."
  fi
}

start_frontend() {
  log "Starting DoomGen frontend with local provider mode..."
  cd "$ROOT_DIR"
  VITE_PROVIDER_MODE=local \
    VITE_DISABLE_CLOUD_PROVIDERS=false \
    VITE_OPENAI_API_KEY="${VITE_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}" \
    VITE_ELEVENLABS_API_KEY="${VITE_ELEVENLABS_API_KEY:-${ELEVENLABS_API_KEY:-}}" \
    VITE_LOCAL_GEN_BASE_URL="$SERVICE_URL" \
    VITE_LOCAL_PLANNER_MODEL="$PLANNER_MODEL" \
    VITE_USE_DOOM_WASM=true \
    npm run dev
}

main() {
  trap cleanup EXIT INT TERM

  load_env_file "$ROOT_DIR/.env"
  ensure_hf_token_aliases

  require_command npm
  require_command curl
  require_command shasum

  resolve_service_python
  if planner_model_looks_local "$PLANNER_MODEL"; then
    if command -v ollama >/dev/null 2>&1; then
      ensure_ollama_running
      ensure_ollama_model
    elif has_openai_planner_config; then
      local openai_model
      openai_model="$(resolve_openai_planner_model)"
      log "Ollama is not installed; falling back planner model to OpenAI ($openai_model)."
      PLANNER_MODEL="$openai_model"
    else
      log "Missing required command: ollama"
      log "Install Ollama for local planner models, or set VITE_OPENAI_API_KEY to use OpenAI planner."
      exit 1
    fi
  elif has_openai_planner_config; then
    log "OpenAI planner detected; skipping Ollama startup."
  elif command -v ollama >/dev/null 2>&1; then
    log "No OpenAI key configured; using Ollama planner."
    ensure_ollama_running
    ensure_ollama_model
  else
    require_command ollama
  fi
  ensure_service_venv
  report_venv_context
  install_service_dependencies
  start_local_service
  check_wad
  start_frontend
}

main "$@"
