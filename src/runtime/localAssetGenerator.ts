import { appEnv } from "../config/env";
import type { AssetRequest } from "../domain/modPlan";
import { createId } from "../util/id";
import type { AssetGenerationResult, AssetGeneratorLike } from "./assetGenerator";
import {
  ProviderAssetGenerator,
  type RuntimeAssetRecord,
  type RuntimeAssetBundle,
  type RuntimeAssetBundleRole
} from "./providerAssetGenerator";

type LocalAssetGeneratorOptions = {
  baseUrl?: string;
  requestTimeoutMs?: number;
};

type LocalAssetPayload = {
  handle?: string;
  mediaType?: string;
  assetUrl?: string;
  playbackUrl?: string;
  source?: string;
  createdAt?: string;
  brief?: string;
  dataUrl?: string;
  base64?: string;
  warnings?: string[];
  bundle?: RuntimeAssetRecord["bundle"];
};

type LocalAssetErrorDetail = {
  category?: "config" | "model_access" | "backend_init" | "generation_runtime" | "timeout" | "unknown";
  message?: string;
  backend?: string;
  model?: string;
  code?: string;
};

export class LocalAssetGenerator implements AssetGeneratorLike {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly records = new Map<string, RuntimeAssetRecord>();
  private readonly providerAssetGenerator: ProviderAssetGenerator;

  constructor(options?: LocalAssetGeneratorOptions) {
    this.baseUrl = trimTrailingSlash(options?.baseUrl ?? appEnv.localGenBaseUrl);
    this.requestTimeoutMs = options?.requestTimeoutMs ?? appEnv.localAssetTimeoutMs;
    this.providerAssetGenerator = new ProviderAssetGenerator();
  }

  async generate(request: AssetRequest, modId: string): Promise<AssetGenerationResult> {
    if (request.kind === "sound_pack" || request.kind === "music_track") {
      return this.providerAssetGenerator.generate(request, modId);
    }

    if (!this.baseUrl) {
      return {
        ok: false,
        request,
        error: "Local asset generator base URL is not configured"
      };
    }

    try {
      const timeoutMs = getRequestTimeoutMs(request, this.requestTimeoutMs);
      const abortController = new AbortController();
      const timeoutId = window.setTimeout(() => {
        abortController.abort();
      }, timeoutMs);
      appendRuntimeLog(
        `local asset request started: ${request.kind}/${request.target} for ${modId} (timeout=${timeoutMs}ms)`
      );
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/v1/generate/asset`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          signal: abortController.signal,
          body: JSON.stringify({
            request,
            modId
          })
        });
      } finally {
        window.clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const parsedDetail = await readResponseDetail(response);
        const details = formatErrorSummary(response.status, parsedDetail);
        appendRuntimeLog(
          `local asset request failed: ${request.kind}/${request.target} (${response.status}) ${details}`
        );
        return {
          ok: false,
          request,
          error: details
        };
      }

      const payload = (await response.json()) as LocalAssetPayload;
      const record = this.toRuntimeRecord(payload, request, modId);
      if (!record) {
        return {
          ok: false,
          request,
          error: "Local asset generation returned no playable asset URL"
        };
      }

      this.records.set(record.handle, record);
      publishRuntimeRecord(record);
      appendRuntimeLog(`local asset request resolved: ${request.kind}/${request.target} -> ${record.handle}`);
      return {
        ok: true,
        request,
        handle: record.handle,
        warnings: normalizeWarnings(payload.warnings)
      };
    } catch (error) {
      const timeoutMs = Math.max(5000, this.requestTimeoutMs);
      if (error instanceof Error && error.name === "AbortError") {
        const message = `Local asset generation timed out after ${Math.round(timeoutMs / 1000)}s`;
        appendRuntimeLog(`local asset request timeout: ${request.kind}/${request.target} (${message})`);
        return {
          ok: false,
          request,
          error: message
        };
      }
      appendRuntimeLog(
        `local asset request exception: ${request.kind}/${request.target} -> ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        ok: false,
        request,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private toRuntimeRecord(
    payload: LocalAssetPayload,
    request: AssetRequest,
    modId: string
  ): RuntimeAssetRecord | undefined {
    const handle = payload.handle?.trim()
      ? payload.handle.trim()
      : createId(`local_${request.kind}_${request.target}_${modId.slice(-6)}`);

    const mediaType = payload.mediaType?.trim()
      ? payload.mediaType.trim()
      : inferMediaType(request.kind);

    const directUrl = payload.playbackUrl?.trim() || payload.assetUrl?.trim() || payload.dataUrl?.trim();
    let playbackUrl = directUrl ?? "";
    if (!playbackUrl && payload.base64?.trim()) {
      playbackUrl = `data:${mediaType};base64,${payload.base64.trim()}`;
    }
    if (!playbackUrl) {
      return undefined;
    }

    const normalizedSource =
      payload.source === "openai" || payload.source === "elevenlabs" || payload.source === "local"
        ? payload.source
        : "local";

    return {
      handle,
      kind: request.kind,
      target: request.target,
      mediaType,
      source: normalizedSource,
      assetUrl: playbackUrl,
      playbackUrl,
      brief: payload.brief ?? request.brief,
      createdAt: payload.createdAt ?? new Date().toISOString(),
      warnings: normalizeWarnings(payload.warnings),
      bundle: normalizeBundle(payload.bundle)
    };
  }
}

function getRequestTimeoutMs(request: AssetRequest, fallbackMs: number): number {
  const base = Math.max(5000, fallbackMs);
  if (request.kind === "enemy_sprite_set" && request.target === "zombieman") {
    return Math.max(base, 600000);
  }
  if (request.kind === "hud_patch_set" && request.target === "doomguy_face") {
    return Math.max(base, 420000);
  }
  return base;
}

function normalizeWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBundle(
  value: RuntimeAssetRecord["bundle"] | undefined
): RuntimeAssetRecord["bundle"] | undefined {
  if (!value || typeof value !== "object" || !("kind" in value) || !("roles" in value)) {
    return undefined;
  }
  const rawBundle = value as RuntimeAssetBundle;
  const roles = Object.fromEntries(
    Object.entries(rawBundle.roles ?? {})
      .filter((entry): entry is [string, RuntimeAssetBundleRole] => {
        const role = entry[1];
        return Boolean(role && typeof role.assetUrl === "string" && role.assetUrl.trim().length > 0);
      })
      .map(([key, role]) => [
        key,
        {
          assetUrl: role.assetUrl.trim(),
          mediaType: typeof role.mediaType === "string" ? role.mediaType.trim() || undefined : undefined,
          derivedFrom: typeof role.derivedFrom === "string" ? role.derivedFrom.trim() || undefined : undefined,
          themeEffect: typeof role.themeEffect === "string" ? role.themeEffect.trim() || undefined : undefined,
          previewUrl: typeof role.previewUrl === "string" ? role.previewUrl.trim() || undefined : undefined,
          metadata: role.metadata && typeof role.metadata === "object" ? role.metadata : undefined
        }
      ])
  ) as RuntimeAssetBundle["roles"];

  if (Object.keys(roles).length === 0) {
    return undefined;
  }
  if (rawBundle.kind === "weapon_sprite_bundle" && !("ready" in roles)) {
    return undefined;
  }

  return {
    kind: rawBundle.kind,
    roles,
    metadata: rawBundle.metadata && typeof rawBundle.metadata === "object" ? rawBundle.metadata : undefined
  } as RuntimeAssetBundle;
}

function formatErrorSummary(status: number, errorDetail: LocalAssetErrorDetail | string): string {
  if (typeof errorDetail === "string" && errorDetail.length > 0) {
    return `Local asset generation failed (${status}): ${errorDetail}`;
  }
  if (typeof errorDetail === "string") {
    return `Local asset generation failed (${status})`;
  }
  const category = errorDetail.category ? `[${errorDetail.category}]` : "[unknown]";
  const backend = errorDetail.backend ? ` backend=${errorDetail.backend}` : "";
  const model = errorDetail.model ? ` model=${errorDetail.model}` : "";
  const message = errorDetail.message
    ? ` ${errorDetail.message}`
    : errorDetail.code
      ? ` ${errorDetail.code}`
      : "";
  return `Local asset generation failed (${status}) ${category}${backend}${model}${message}`;
}

function inferMediaType(kind: AssetRequest["kind"]): string {
  if (kind === "sound_pack" || kind === "music_track") {
    return "audio/wav";
  }
  return "image/png";
}

function publishRuntimeRecord(record: RuntimeAssetRecord): void {
  const windowState = window as unknown as {
    __doomModAssetRuntimeRecords?: Record<string, RuntimeAssetRecord>;
  };
  windowState.__doomModAssetRuntimeRecords = windowState.__doomModAssetRuntimeRecords ?? {};
  windowState.__doomModAssetRuntimeRecords[record.handle] = record;
}

function appendRuntimeLog(message: string): void {
  const windowState = window as unknown as {
    __doomModRuntimeLog?: string[];
  };
  windowState.__doomModRuntimeLog = windowState.__doomModRuntimeLog ?? [];
  const entry = `[doom-mod] ${new Date().toISOString()} ${message}`;
  windowState.__doomModRuntimeLog.push(entry);
  windowState.__doomModRuntimeLog = windowState.__doomModRuntimeLog.slice(-160);
  console.info(entry);
}

function trimTrailingSlash(value: string): string {
  const normalized = value.trim();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function readResponseSummary(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }
    return text.replace(/\s+/g, " ").slice(0, 220);
  } catch {
    return "";
  }
}

async function readResponseDetail(response: Response): Promise<LocalAssetErrorDetail | string> {
  try {
    const payload = (await response.clone().json()) as {
      detail?: unknown;
    error?: string | LocalAssetErrorDetail | LocalAssetErrorDetail[];
    category?: string;
  };
    const rawCategory =
      typeof payload.category === "string" ? payload.category : undefined;
    const detailRaw = pickKnownErrorDetail(payload.detail);
    if (detailRaw) {
      return normalizeErrorDetail({
        ...detailRaw,
        category: detailRaw.category ?? rawCategory
      });
    }
    const errorRaw = pickKnownErrorDetail(payload.error);
    if (errorRaw) {
      return normalizeErrorDetail({
        ...errorRaw,
        category: errorRaw.category ?? rawCategory
      });
    }
    if (typeof rawCategory === "string") {
      return {
        category: rawCategory as LocalAssetErrorDetail["category"]
      };
    }
    return (await response.text()).trim();
  } catch {
    const fallback = await readResponseSummary(response);
    return fallback;
  }
}

function normalizeErrorDetail(value: { category?: string; message?: string; backend?: string; model?: string; code?: string }): LocalAssetErrorDetail {
  return {
    category: normalizeCategory(value.category),
    message: typeof value.message === "string" ? value.message.trim().slice(0, 500) : undefined,
    backend: typeof value.backend === "string" ? value.backend.trim() : undefined,
    model: typeof value.model === "string" ? value.model.trim() : undefined,
    code: typeof value.code === "string" ? value.code.trim() : undefined
  };
}

function pickKnownErrorDetail(value: unknown): LocalAssetErrorDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const detail = value as Record<string, unknown>;
  const message = typeof detail.message === "string" ? detail.message : undefined;
  const category = normalizeCategory(
    typeof detail.category === "string" ? detail.category : undefined
  );
  const backend = typeof detail.backend === "string" ? detail.backend : undefined;
  const model = typeof detail.model === "string" ? detail.model : undefined;
  const code = typeof detail.code === "string" ? detail.code : undefined;
  if (!category && !message && !backend && !model && !code) {
    return undefined;
  }
  return { category, message, backend, model, code };
}

function normalizeCategory(value: string | undefined): LocalAssetErrorDetail["category"] {
  if (
    value === "config" ||
    value === "model_access" ||
    value === "backend_init" ||
    value === "generation_runtime" ||
    value === "timeout"
  ) {
    return value;
  }
  return undefined;
}
