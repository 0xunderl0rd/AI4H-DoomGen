import { appEnv } from "../config/env";
import type { AssetRequest } from "../domain/modPlan";
import { createId } from "../util/id";
import type { AssetGenerationResult, AssetGeneratorLike } from "./assetGenerator";
import { generateOpenAiHudFaceBundle } from "./openAiHudFaceBundle";
import { generateOpenAiZombiemanAtlasBundle } from "./openAiZombiemanAtlas";
import {
  buildAudioPrompt,
  buildImagePrompt,
  getImageGenerationProfile
} from "./promptProfiles";

type ProviderAssetGeneratorOptions = {
  openAiApiKey?: string;
  openAiImageModel?: string;
  elevenLabsApiKey?: string;
  elevenLabsBaseUrl?: string;
};

type GeneratedAssetRecord = {
  handle: string;
  kind: AssetRequest["kind"];
  target: AssetRequest["target"];
  mimeType: string;
  source: "openai" | "elevenlabs" | "local";
  dataUrl?: string;
  remoteUrl?: string;
  createdAt: string;
  brief?: string;
  warnings?: string[];
  bundle?: RuntimeAssetBundle;
};

export type RuntimeAssetRecord = {
  handle: string;
  kind: AssetRequest["kind"];
  target: AssetRequest["target"];
  mediaType: string;
  source: "openai" | "elevenlabs" | "local";
  assetUrl: string;
  playbackUrl: string;
  brief?: string;
  createdAt: string;
  warnings?: string[];
  bundle?: RuntimeAssetBundle;
};

export type RuntimeAssetBundleRole = {
  assetUrl: string;
  mediaType?: string;
  derivedFrom?: string;
  themeEffect?: string;
  previewUrl?: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeAssetBundle =
  | {
      kind: "weapon_sprite_bundle";
      roles: Partial<Record<"ready" | "attack" | "flash", RuntimeAssetBundleRole>>;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "enemy_sprite_bundle";
      roles: Record<string, RuntimeAssetBundleRole>;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "hud_patch_bundle";
      roles: Record<string, RuntimeAssetBundleRole>;
      metadata?: Record<string, unknown>;
    };

export class ProviderAssetGenerator implements AssetGeneratorLike {
  private readonly openAiApiKey: string;
  private readonly openAiImageModel: string;
  private readonly elevenLabsApiKey: string;
  private readonly elevenLabsBaseUrl: string;
  private readonly records = new Map<string, GeneratedAssetRecord>();

  constructor(options?: ProviderAssetGeneratorOptions) {
    this.openAiApiKey = options?.openAiApiKey ?? appEnv.openAiApiKey;
    this.openAiImageModel = options?.openAiImageModel ?? appEnv.openAiImageModel;
    this.elevenLabsApiKey = options?.elevenLabsApiKey ?? appEnv.elevenLabsApiKey;
    this.elevenLabsBaseUrl = options?.elevenLabsBaseUrl ?? appEnv.elevenLabsBaseUrl;
  }

  getRecord(handle: string): GeneratedAssetRecord | undefined {
    return this.records.get(handle);
  }

  getRuntimeRecord(handle: string): RuntimeAssetRecord | undefined {
    const record = this.records.get(handle);
    const playbackUrl = pickPlaybackUrl(record);
    if (!record || !playbackUrl) {
      return undefined;
    }
    return {
      handle: record.handle,
      kind: record.kind,
      target: record.target,
      mediaType: record.mimeType,
      source: record.source,
      assetUrl: playbackUrl,
      playbackUrl,
      brief: record.brief,
      createdAt: record.createdAt
    };
  }

  getAllRecords(): GeneratedAssetRecord[] {
    return Array.from(this.records.values());
  }

  getRuntimeRecords(): RuntimeAssetRecord[] {
    return Array.from(this.records.values())
      .map(getRuntimeAssetRecord)
      .filter((record): record is RuntimeAssetRecord => record !== undefined);
  }

  async generate(request: AssetRequest, modId: string): Promise<AssetGenerationResult> {
    console.info(
      `[doom-mod] generate start ${request.kind}/${request.target} for ${modId} (brief=${request.brief})`
    );
    try {
      const handle = await this.generateInternal(request, modId);
      console.info(`[doom-mod] generate success ${request.kind}/${request.target} -> ${handle}`);
      this.recordGenerationEvent(`ok:${request.kind}/${request.target}`, handle);
      const record = this.getRecord(handle);
      if (record) {
        this.recordRuntimeRecord(record);
      }
      return {
        ok: true,
        request,
        handle
      };
    } catch (error) {
      console.warn(
        `[doom-mod] generate failed ${request.kind}/${request.target}: ${error instanceof Error ? error.message : String(error)}`
      );
      this.recordGenerationEvent(
        `failed:${request.kind}/${request.target}`,
        error instanceof Error ? error.message : String(error)
      );
      return {
        ok: false,
        request,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private reportAssetProgress(request: AssetRequest, modId: string, message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    const windowState = window as unknown as {
      __doomModReportAssetProgress?: (
        modId: string,
        kind: AssetRequest["kind"],
        target: AssetRequest["target"],
        message: string
      ) => void;
    };
    windowState.__doomModReportAssetProgress?.(modId, request.kind, request.target, trimmed);
    this.recordGenerationEvent(`progress:${request.kind}/${request.target}`, trimmed);
  }

  private recordRuntimeRecord(record: GeneratedAssetRecord): void {
    const runtimeRecord = getRuntimeAssetRecord(record);
    if (!runtimeRecord) {
      return;
    }
    const windowState = window as unknown as {
      __doomModAssetRuntimeRecords?: Record<string, RuntimeAssetRecord>;
    };
    windowState.__doomModAssetRuntimeRecords = windowState.__doomModAssetRuntimeRecords ?? {};
    windowState.__doomModAssetRuntimeRecords[record.handle] = runtimeRecord;
  }

  private async generateInternal(request: AssetRequest, modId: string): Promise<string> {
    switch (request.kind) {
      case "enemy_sprite_set":
      case "weapon_sprite_set":
      case "pickup_sprite_set":
      case "projectile_fx_set":
      case "hud_patch_set":
      case "wall_texture_set":
      case "flat_texture_set":
        return this.generateImageAsset(request, modId);
      case "sound_pack":
      case "music_track":
        return this.generateAudioAsset(request, modId);
    }
  }

  private async generateImageAsset(
    request: Extract<
      AssetRequest,
      {
        kind:
          | "enemy_sprite_set"
          | "weapon_sprite_set"
          | "pickup_sprite_set"
          | "projectile_fx_set"
          | "hud_patch_set"
          | "wall_texture_set"
          | "flat_texture_set";
      }
    >,
    modId: string
  ): Promise<string> {
    if (request.kind === "enemy_sprite_set" && request.target === "zombieman") {
      if (!this.openAiApiKey) {
        throw new Error("OpenAI API key is missing for visual generation");
      }
      const bundleResult = await generateOpenAiZombiemanAtlasBundle({
        apiKey: this.openAiApiKey,
        model: this.openAiImageModel,
        brief: request.brief,
        onPhase: (message) => {
          this.reportAssetProgress(request, modId, message);
        }
      });
      const handle = createId(`asset_${request.kind}_${request.target}_${modId.slice(-6)}`);
      const record: GeneratedAssetRecord = {
        handle,
        kind: request.kind,
        target: request.target,
        mimeType: bundleResult.mediaType,
        source: "openai",
        brief: request.brief,
        createdAt: new Date().toISOString(),
        dataUrl: bundleResult.assetUrl,
        warnings: bundleResult.warnings,
        bundle: bundleResult.bundle
      };
      this.records.set(handle, record);
      return handle;
    }

    if (request.kind === "hud_patch_set" && request.target === "doomguy_face") {
      if (!this.openAiApiKey) {
        throw new Error("OpenAI API key is missing for visual generation");
      }
      const bundleResult = await generateOpenAiHudFaceBundle({
        apiKey: this.openAiApiKey,
        model: this.openAiImageModel,
        brief: request.brief,
        onPhase: (message) => {
          this.reportAssetProgress(request, modId, message);
        }
      });
      const handle = createId(`asset_${request.kind}_${request.target}_${modId.slice(-6)}`);
      const record: GeneratedAssetRecord = {
        handle,
        kind: request.kind,
        target: request.target,
        mimeType: bundleResult.mediaType,
        source: "openai",
        brief: request.brief,
        createdAt: new Date().toISOString(),
        dataUrl: bundleResult.assetUrl,
        warnings: bundleResult.warnings,
        bundle: bundleResult.bundle
      };
      this.records.set(handle, record);
      return handle;
    }

    if (!this.openAiApiKey) {
      throw new Error("OpenAI API key is missing for visual generation");
    }

    const profile = getImageGenerationProfile(request, this.openAiImageModel);
    const prompt = buildImagePrompt(request);
    let response = await this.requestOpenAiImageGeneration(profile, prompt);

    if (!response.ok && profile.model !== "gpt-image-1") {
      response = await this.requestOpenAiImageGeneration(
        {
          ...profile,
          model: "gpt-image-1"
        },
        prompt
      );
    }

    if (!response.ok) {
      throw new Error(`OpenAI image generation failed (${response.status})`);
    }

    const payload = (await response.json()) as {
      data?: Array<{
        b64_json?: string;
        url?: string;
      }>;
    };

    const image = payload.data?.[0];
    if (!image) {
      throw new Error("OpenAI image generation returned no image");
    }

    const handle = createId(`asset_${request.kind}_${request.target}_${modId.slice(-6)}`);
    const record: GeneratedAssetRecord = {
      handle,
      kind: request.kind,
      target: request.target,
      mimeType: profile.outputFormat === "jpeg" ? "image/jpeg" : "image/png",
      source: "openai",
      brief: request.brief,
      createdAt: new Date().toISOString()
    };
    if (image.b64_json) {
      record.dataUrl = `data:${record.mimeType};base64,${image.b64_json}`;
    }
    if (image.url) {
      record.remoteUrl = image.url;
    }
    this.records.set(handle, record);
    return handle;
  }

  private async requestOpenAiImageGeneration(
    profile: ReturnType<typeof getImageGenerationProfile>,
    prompt: string
  ): Promise<Response> {
    return fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.openAiApiKey}`
      },
      body: JSON.stringify({
        model: profile.model,
        prompt,
        size: profile.size,
        quality: profile.quality,
        background: profile.background,
        output_format: profile.outputFormat,
        output_compression: profile.outputCompression,
        n: profile.n,
        moderation: profile.moderation
      })
    });
  }

  private async generateAudioAsset(request: AssetRequest, modId: string): Promise<string> {
    if (!this.elevenLabsApiKey) {
      throw new Error("ElevenLabs API key is missing for audio generation");
    }

    const audioPrompt = buildAudioPrompt(request);
    console.info(
      `[doom-mod] ElevenLabs sound-generation prompt (${audioPrompt.length} chars): ${audioPrompt}`
    );
    const soundGenerationUrl = `${trimTrailingSlash(this.elevenLabsBaseUrl)}/sound-generation`;
    const soundResponse = await fetch(soundGenerationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": this.elevenLabsApiKey
      },
      body: JSON.stringify({
        text: audioPrompt,
        duration_seconds: request.kind === "music_track" ? 20 : 4
      })
    });

    if (soundResponse.ok) {
      const handle = createId(`asset_${request.kind}_${request.target}_${modId.slice(-6)}`);
      const contentType = soundResponse.headers.get("content-type") ?? "audio/mpeg";
      const record: GeneratedAssetRecord = {
        handle,
        kind: request.kind,
        target: request.target,
        mimeType: contentType,
        source: "elevenlabs",
        brief: request.brief,
        createdAt: new Date().toISOString()
      };

      if (isDirectAudioResponse(contentType)) {
        const audioBuffer = await soundResponse.arrayBuffer();
        record.dataUrl = `data:${contentType};base64,${bytesToBase64(new Uint8Array(audioBuffer))}`;
      } else {
        const payloadText = await soundResponse.text();
        const parsed = safeJson(payloadText);
        if (parsed && typeof parsed.audio_url === "string") {
          record.remoteUrl = parsed.audio_url;
        }
        if (parsed && typeof parsed.audio_base64 === "string") {
          record.dataUrl = `data:audio/mpeg;base64,${parsed.audio_base64}`;
        }
      }

      if (!record.dataUrl && !record.remoteUrl) {
        throw new Error("ElevenLabs sound generation returned no playable audio");
      }

      this.records.set(handle, record);
      return handle;
    }

    const failureDetails = await readResponseSummary(soundResponse);
    throw new Error(
      `ElevenLabs sound-generation failed (${soundResponse.status})${failureDetails ? `: ${failureDetails}` : ""}`
    );
  }

  private recordGenerationEvent(label: string, value: string): void {
    const windowLog = window as unknown as {
      __doomModAssetRuntimeLog?: string[];
      __doomModAssetRecords?: GeneratedAssetRecord[];
    };
    const entry = `[doom-mod-asset] ${new Date().toISOString()} ${label} ${value}`;
    windowLog.__doomModAssetRuntimeLog = windowLog.__doomModAssetRuntimeLog ?? [];
    windowLog.__doomModAssetRuntimeLog.push(entry);
    windowLog.__doomModAssetRuntimeLog = windowLog.__doomModAssetRuntimeLog.slice(-120);
    windowLog.__doomModAssetRecords = Array.from(this.records.values()).slice(-240);
    console.info(entry);
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readResponseSummary(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }

    const parsed = safeJson(text);
    if (parsed) {
      const detail =
        readStringProperty(parsed, "detail")
        ?? readStringProperty(parsed, "message")
        ?? readStringProperty(parsed, "error");
      if (detail) {
        return detail;
      }
    }

    return text.replace(/\s+/g, " ").slice(0, 220);
  } catch {
    return "";
  }
}

function readStringProperty(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function getRuntimeAssetRecord(record: GeneratedAssetRecord): RuntimeAssetRecord | undefined {
  const playbackUrl = pickPlaybackUrl(record);
  if (!playbackUrl) {
    return undefined;
  }
  return {
    handle: record.handle,
    kind: record.kind,
    target: record.target,
    mediaType: record.mimeType,
    source: record.source,
    assetUrl: playbackUrl,
    playbackUrl,
    brief: record.brief,
    createdAt: record.createdAt,
    warnings: record.warnings,
    bundle: record.bundle
  };
}

function pickPlaybackUrl(record?: GeneratedAssetRecord): string | undefined {
  if (!record) {
    return undefined;
  }
  if (record.dataUrl) {
    return record.dataUrl;
  }
  if (record.remoteUrl) {
    return record.remoteUrl;
  }
  return undefined;
}

function isDirectAudioResponse(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("audio/") || normalized.startsWith("application/octet-stream");
}
