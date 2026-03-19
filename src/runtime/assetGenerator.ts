import type { AssetRequest } from "../domain/modPlan";
import { createId } from "../util/id";
import type { RuntimeAssetRecord } from "./providerAssetGenerator";

export type AssetGenerationResult =
  | {
      ok: true;
      request: AssetRequest;
      handle: string;
      warnings?: string[];
    }
  | {
      ok: false;
      request: AssetRequest;
      error: string;
    };

export interface AssetGeneratorLike {
  generate(request: AssetRequest, modId: string): Promise<AssetGenerationResult>;
}

type AssetGeneratorOptions = {
  failureRate?: number;
  minimumDelayMs?: number;
  maximumDelayMs?: number;
};

const DEFAULT_OPTIONS: Required<AssetGeneratorOptions> = {
  failureRate: 0,
  minimumDelayMs: 200,
  maximumDelayMs: 700
};

export class AssetGenerator implements AssetGeneratorLike {
  private readonly options: Required<AssetGeneratorOptions>;
  private readonly records = new Map<string, RuntimeAssetRecord>();

  constructor(options?: AssetGeneratorOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    };
  }

  async generate(request: AssetRequest, modId: string): Promise<AssetGenerationResult> {
    const minDelay = this.options.minimumDelayMs;
    const maxDelay = this.options.maximumDelayMs;
    const randomizedDelay = randomBetween(minDelay, maxDelay);
    await delay(randomizedDelay);

    const failed = Math.random() < this.options.failureRate;
    if (failed) {
      return {
        ok: false,
        request,
        error: `Generation failed for ${request.kind}:${request.target}`
      };
    }

    const baseHandle = createId(`${request.kind}_${request.target}_${modId.slice(-4)}`);
    const record = buildMockRuntimeAssetRecord(baseHandle, request);
    this.records.set(baseHandle, record);
    recordRuntimeAssetRecord(record);
    return {
      ok: true,
      request,
      handle: baseHandle
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function randomBetween(min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildMockRuntimeAssetRecord(
  handle: string,
  request: AssetRequest
): RuntimeAssetRecord {
  const assetUrl = isImageAssetRequest(request)
    ? createMockImageDataUrl(request)
    : createMockAudioDataUrl(request);

  return {
    handle,
    kind: request.kind,
    target: request.target,
    mediaType: isImageAssetRequest(request) ? "image/svg+xml" : "audio/wav",
    source: request.kind === "music_track" ? "elevenlabs" : "openai",
    assetUrl,
    playbackUrl: assetUrl,
    brief: request.brief,
    createdAt: new Date().toISOString()
  };
}

function recordRuntimeAssetRecord(record: RuntimeAssetRecord): void {
  const windowState = window as unknown as {
    __doomModAssetRuntimeRecords?: Record<string, RuntimeAssetRecord>;
  };
  windowState.__doomModAssetRuntimeRecords = windowState.__doomModAssetRuntimeRecords ?? {};
  windowState.__doomModAssetRuntimeRecords[record.handle] = record;
}

function createMockImageDataUrl(request: AssetRequest): string {
  const brief = request.brief.toLowerCase();
  const isFishWeapon = request.kind === "weapon_sprite_set" && brief.includes("fish");
  const isImp = request.kind === "enemy_sprite_set";
  const isTexture = request.kind === "wall_texture_set" || request.kind === "flat_texture_set";
  const isHud = request.kind === "hud_patch_set";
  const isPickup = request.kind === "pickup_sprite_set";
  const svg = isFishWeapon
    ? buildFishPistolSvg()
    : isImp
      ? buildImpSvg()
      : isTexture
        ? buildTextureSvg()
        : isHud
          ? buildHudPatchSvg()
          : isPickup
            ? buildPickupSvg()
            : buildGenericWeaponSvg();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function isImageAssetRequest(
  request: AssetRequest
): request is Extract<
  AssetRequest,
  {
    kind:
      | "weapon_sprite_set"
      | "enemy_sprite_set"
      | "pickup_sprite_set"
      | "projectile_fx_set"
      | "hud_patch_set"
      | "wall_texture_set"
      | "flat_texture_set";
  }
> {
  return request.kind !== "sound_pack" && request.kind !== "music_track";
}

function buildFishPistolSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f1c26"/>
      <stop offset="100%" stop-color="#05090d"/>
    </linearGradient>
    <linearGradient id="fish" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffb24d"/>
      <stop offset="100%" stop-color="#d96b2b"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <ellipse cx="256" cy="308" rx="112" ry="72" fill="url(#fish)" stroke="#442311" stroke-width="8"/>
  <polygon points="346,310 430,254 426,368" fill="#f18a46" stroke="#442311" stroke-width="8"/>
  <polygon points="236,254 274,202 316,250" fill="#f9c46b" stroke="#442311" stroke-width="8"/>
  <polygon points="240,360 274,398 214,406" fill="#f9c46b" stroke="#442311" stroke-width="8"/>
  <circle cx="208" cy="296" r="16" fill="#fff7d6" stroke="#442311" stroke-width="6"/>
  <circle cx="212" cy="298" r="7" fill="#141414"/>
  <path d="M162 324c22 16 58 20 84 12" fill="none" stroke="#442311" stroke-width="8" stroke-linecap="round"/>
  <rect x="222" y="356" width="62" height="106" rx="12" fill="#5b3520" stroke="#24130a" stroke-width="8"/>
  <rect x="286" y="330" width="108" height="28" rx="14" fill="#6e8290" stroke="#25303a" stroke-width="8"/>
  <circle cx="410" cy="344" r="10" fill="#ffd27d"/>
</svg>`.trim();
}

function buildGenericWeaponSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0b0f14"/>
  <rect x="200" y="148" width="112" height="208" rx="22" fill="#6d7b8a"/>
  <rect x="278" y="182" width="122" height="34" rx="14" fill="#8898aa"/>
  <rect x="228" y="324" width="56" height="138" rx="12" fill="#473022"/>
</svg>`.trim();
}

function buildImpSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0b0910"/>
  <path d="M176 406c12-110 44-214 80-214s68 104 80 214" fill="#7e4c39" stroke="#26140f" stroke-width="10"/>
  <circle cx="256" cy="160" r="74" fill="#935941" stroke="#26140f" stroke-width="10"/>
  <circle cx="226" cy="148" r="12" fill="#ffe7c5"/>
  <circle cx="286" cy="148" r="12" fill="#ffe7c5"/>
  <path d="M220 190c20 20 52 20 72 0" fill="none" stroke="#26140f" stroke-width="10" stroke-linecap="round"/>
</svg>`.trim();
}

function buildPickupSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#080b10"/>
  <rect x="180" y="126" width="152" height="260" rx="22" fill="#b72a28" stroke="#3e0f0d" stroke-width="12"/>
  <rect x="238" y="150" width="36" height="212" rx="10" fill="#f8df9d"/>
  <rect x="208" y="238" width="96" height="36" rx="10" fill="#f8df9d"/>
</svg>`.trim();
}

function buildHudPatchSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="160" viewBox="0 0 512 160">
  <rect width="512" height="160" fill="#6c6c6c"/>
  <rect x="14" y="14" width="484" height="132" fill="#3d3d3d" stroke="#8e8e8e" stroke-width="10"/>
  <rect x="208" y="24" width="96" height="112" fill="#161616"/>
  <circle cx="256" cy="82" r="34" fill="#d1a06e"/>
  <rect x="60" y="42" width="88" height="64" fill="#8a1515"/>
  <rect x="364" y="42" width="88" height="64" fill="#8a1515"/>
</svg>`.trim();
}

function buildTextureSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#2c2f35"/>
  <rect x="0" y="0" width="170" height="512" fill="#4b4f58"/>
  <rect x="170" y="0" width="172" height="512" fill="#2e333b"/>
  <rect x="342" y="0" width="170" height="512" fill="#515660"/>
  <g fill="#7c7f87">
    <rect x="22" y="30" width="126" height="24"/>
    <rect x="192" y="104" width="128" height="24"/>
    <rect x="362" y="56" width="120" height="24"/>
    <rect x="192" y="302" width="128" height="24"/>
    <rect x="28" y="392" width="118" height="24"/>
  </g>
</svg>`.trim();
}

function createMockAudioDataUrl(request: AssetRequest): string {
  const brief = request.brief.toLowerCase();
  const waveform =
    request.kind === "sound_pack" && request.target === "pistol"
      ? brief.includes("honk") || brief.includes("horn")
        ? buildHonkWaveform()
        : brief.includes("burp") || brief.includes("belch")
          ? buildBurpWaveform()
          : buildShotWaveform()
      : buildAmbientWaveform();

  return encodeWaveformAsDataUrl(waveform, 22050);
}

function buildHonkWaveform(): Float32Array {
  return buildWaveform(0.36, 22050, (t) => {
    const env = Math.exp(-3.2 * t);
    return env * (Math.sin(Math.PI * 2 * 392 * t) * 0.55 + Math.sin(Math.PI * 2 * 494 * t) * 0.4);
  });
}

function buildBurpWaveform(): Float32Array {
  return buildWaveform(0.42, 22050, (t) => {
    const base = 140 - t * 70;
    const wobble = Math.sin(Math.PI * 2 * 6 * t) * 14;
    const env = Math.exp(-2.7 * t);
    return env * Math.sin(Math.PI * 2 * (base + wobble) * t) * 0.8;
  });
}

function buildShotWaveform(): Float32Array {
  return buildWaveform(0.22, 22050, (t) => {
    const env = Math.exp(-12 * t);
    const noise = Math.sin(Math.PI * 2 * 860 * t) * 0.5 + Math.sin(Math.PI * 2 * 1320 * t) * 0.35;
    return env * noise;
  });
}

function buildAmbientWaveform(): Float32Array {
  return buildWaveform(1.4, 22050, (t) => {
    const env = Math.min(1, t * 2) * Math.min(1, (1.4 - t) * 3);
    return env * Math.sin(Math.PI * 2 * 180 * t) * 0.35;
  });
}

function buildWaveform(
  durationSeconds: number,
  sampleRate: number,
  sampleAtTime: (timeSeconds: number) => number
): Float32Array {
  const sampleCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    samples[i] = Math.max(-1, Math.min(1, sampleAtTime(t)));
  }
  return samples;
}

function encodeWaveformAsDataUrl(samples: Float32Array, sampleRate: number): string {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return `data:audio/wav;base64,${arrayBufferToBase64(buffer)}`;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
