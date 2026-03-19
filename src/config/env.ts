const env = import.meta.env;

export type ProviderMode = "cloud" | "local" | "hybrid";

export const appEnv = {
  providerMode: normalizeProviderMode(env.VITE_PROVIDER_MODE),
  disableCloudProviders: parseBoolean(env.VITE_DISABLE_CLOUD_PROVIDERS, false),
  openAiApiKey: (env.VITE_OPENAI_API_KEY ?? "").trim(),
  openAiModel: (env.VITE_OPENAI_MODEL ?? "gpt-4.1-mini").trim(),
  openAiImageModel: (env.VITE_OPENAI_IMAGE_MODEL ?? "gpt-image-1.5").trim(),
  elevenLabsApiKey: (env.VITE_ELEVENLABS_API_KEY ?? "").trim(),
  elevenLabsBaseUrl: (env.VITE_ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io/v1").trim(),
  elevenLabsVoiceId: (env.VITE_ELEVENLABS_VOICE_ID ?? "").trim(),
  localGenBaseUrl: (env.VITE_LOCAL_GEN_BASE_URL ?? "http://127.0.0.1:8000").trim(),
  localPlannerModel: (env.VITE_LOCAL_PLANNER_MODEL ?? "qwen2.5:1.5b").trim(),
  localAssetTimeoutMs: parsePositiveInt(env.VITE_LOCAL_ASSET_TIMEOUT_MS, 180000),
  doomWasmJsUrl: (env.VITE_DOOM_WASM_JS_URL ?? "/doom-wasm/websockets-doom.js").trim(),
  doomWadUrl: (env.VITE_DOOM_WASM_WAD_URL ?? "/doom/doom1.wad").trim(),
  useDoomWasm: String(env.VITE_USE_DOOM_WASM ?? "false").toLowerCase() === "true"
};

export function hasOpenAiConfig(): boolean {
  return isConfiguredSecret(appEnv.openAiApiKey);
}

export function hasElevenLabsConfig(): boolean {
  return isConfiguredSecret(appEnv.elevenLabsApiKey);
}

export function hasLocalGenerationConfig(): boolean {
  return appEnv.localGenBaseUrl.length > 0;
}

function isConfiguredSecret(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return !/^YOUR_[A-Z0-9_]+_HERE$/i.test(value);
}

function normalizeProviderMode(value: string | undefined): ProviderMode {
  const normalized = String(value ?? "cloud").trim().toLowerCase();
  if (normalized === "local" || normalized === "hybrid" || normalized === "cloud") {
    return normalized;
  }
  return "cloud";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const raw = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}
