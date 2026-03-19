import { z } from "zod";

import { clampOptional } from "../util/clamp";
import {
  DOOM1_FLAT_TEXTURE_TYPES,
  DOOM1_HUD_PATCH_TYPES,
  DOOM1_PICKUP_TYPES,
  DOOM1_PROJECTILE_FX_TYPES,
  DOOM1_WALL_TEXTURE_TYPES,
  ENEMY_TYPES,
  WEAPON_TYPES
} from "./doom1Content";

export {
  DOOM1_FLAT_TEXTURE_TYPES,
  DOOM1_HUD_PATCH_TYPES,
  DOOM1_PICKUP_TYPES,
  DOOM1_PROJECTILE_FX_TYPES,
  DOOM1_WALL_TEXTURE_TYPES,
  ENEMY_TYPES,
  MUSIC_TARGETS,
  WEAPON_TYPES
} from "./doom1Content";

export const MUTATION_FAMILIES = [
  "physics",
  "weapon_behavior",
  "weapon_visual",
  "weapon_audio",
  "enemy_visual",
  "enemy_audio",
  "music",
  "presentation_fx"
] as const;

export const MOD_STATUSES = [
  "planning",
  "applying",
  "generating_assets",
  "complete",
  "partial",
  "failed"
] as const;

export const PROJECTILE_PRESETS = [
  "bullet",
  "hook",
  "arcing",
  "spread",
  "piercing"
] as const;

export type MutationFamily = (typeof MUTATION_FAMILIES)[number];
export type ModStatus = (typeof MOD_STATUSES)[number];
export type WeaponType = (typeof WEAPON_TYPES)[number];
export type EnemyType = (typeof ENEMY_TYPES)[number];
export type PickupType = (typeof DOOM1_PICKUP_TYPES)[number];
export type ProjectileFxType = (typeof DOOM1_PROJECTILE_FX_TYPES)[number];
export type HudPatchType = (typeof DOOM1_HUD_PATCH_TYPES)[number];
export type WallTextureType = (typeof DOOM1_WALL_TEXTURE_TYPES)[number];
export type FlatTextureType = (typeof DOOM1_FLAT_TEXTURE_TYPES)[number];
export type ProjectilePreset = (typeof PROJECTILE_PRESETS)[number];

export type WeaponOverride = {
  weaponType: WeaponType;
  displayName?: string;
  projectilePreset?: ProjectilePreset;
  fireRateScale?: number;
};

export type AssetRequest =
  | {
      kind: "enemy_sprite_set";
      target: EnemyType;
      brief: string;
      frameBudget: "low";
    }
  | {
      kind: "weapon_sprite_set";
      target: WeaponType;
      brief: string;
      frameBudget: "low";
    }
  | {
      kind: "pickup_sprite_set";
      target: PickupType;
      brief: string;
      frameBudget: "low";
    }
  | {
      kind: "projectile_fx_set";
      target: ProjectileFxType;
      brief: string;
      frameBudget: "low";
    }
  | {
      kind: "hud_patch_set";
      target: HudPatchType;
      brief: string;
      frameBudget: "low";
    }
  | {
      kind: "wall_texture_set";
      target: WallTextureType;
      brief: string;
      frameBudget: "low";
    }
  | {
      kind: "flat_texture_set";
      target: FlatTextureType;
      brief: string;
      frameBudget: "low";
    }
  | {
      kind: "sound_pack";
      target: EnemyType | WeaponType;
      brief: string;
    }
  | {
      kind: "music_track";
      target: "level";
      brief: string;
    };

export type ModPlan = {
  id: string;
  prompt: string;
  title: string;
  summary: string;
  status: ModStatus;
  families: MutationFamily[];
  mechanics?: {
    gravityScale?: number;
    playerMoveScale?: number;
    projectileSpeedScale?: number;
    weaponOverrides?: WeaponOverride[];
  };
  presentation?: {
    screenTint?: string;
    saturationScale?: number;
    uiThemeName?: string;
  };
  assetRequests?: AssetRequest[];
  limitations?: string[];
};

export type ResolvedAssets = {
  modId: string;
  enemySpriteManifests?: Array<{ target: EnemyType; manifestId: string }>;
  weaponSpriteManifests?: Array<{ target: WeaponType; manifestId: string }>;
  hudPatchManifests?: Array<{ target: HudPatchType; manifestId: string }>;
  soundPacks?: Array<{ target: EnemyType | WeaponType; packId: string }>;
  musicTracks?: Array<{ target: "level"; trackId: string }>;
};

type PlanValidationSuccess = {
  ok: true;
  plan: ModPlan;
  dropped: string[];
};

type PlanValidationError = {
  ok: false;
  errors: string[];
};

export type PlanValidationResult = PlanValidationSuccess | PlanValidationError;

type ValidationFallback = {
  fallbackId: string;
  fallbackPrompt: string;
};

const rawWeaponOverrideSchema = z.object({
  weaponType: z.string(),
  displayName: z.string().max(80).optional(),
  projectilePreset: z.string().optional(),
  fireRateScale: z.number().finite().optional()
});

const rawAssetRequestSchema = z.object({
  kind: z.string(),
  target: z.string(),
  brief: z.string().max(400).optional(),
  frameBudget: z.string().optional()
});

const rawModPlanSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    title: z.string().min(1).max(120).optional(),
    summary: z.string().min(1).max(300).optional(),
    status: z.string().optional(),
    families: z.array(z.string()).default([]),
    mechanics: z
      .object({
        gravityScale: z.number().finite().optional(),
        playerMoveScale: z.number().finite().optional(),
        projectileSpeedScale: z.number().finite().optional(),
        weaponOverrides: z.array(rawWeaponOverrideSchema).optional()
      })
      .optional(),
    presentation: z
      .object({
        screenTint: z.string().max(32).optional(),
        saturationScale: z.number().finite().optional(),
        uiThemeName: z.string().max(32).optional()
      })
      .optional(),
    assetRequests: z.array(rawAssetRequestSchema).optional(),
    limitations: z.array(z.string().max(160)).optional()
  })
  .strip();

export function validateAndNormalizeModPlan(
  rawInput: unknown,
  fallback: ValidationFallback
): PlanValidationResult {
  const parsed = rawModPlanSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`
      )
    };
  }

  const raw = parsed.data;
  const dropped: string[] = [];

  const normalizedPrompt = (raw.prompt ?? fallback.fallbackPrompt).trim();
  const normalizedId = (raw.id ?? fallback.fallbackId).trim();

  const normalizedFamilies = normalizeFamilies(raw.families, dropped);
  const normalizedMechanics = normalizeMechanics(raw.mechanics, dropped);
  const normalizedPresentation = normalizePresentation(raw.presentation, dropped);
  const normalizedAssetRequests = filterAssetRequestsForPromptIntent(
    normalizedPrompt,
    normalizeAssetRequests(raw.assetRequests, dropped)
  );

  const inferredFamilies = inferFamilies(
    normalizedFamilies,
    normalizedMechanics,
    normalizedPresentation,
    normalizedAssetRequests
  );
  const title = normalizeTitle(raw.title, normalizedPrompt);
  const status = normalizeStatus(raw.status);
  const limitations = dedupe([
    ...(raw.limitations ?? []),
    ...dropped
  ]);
  const summary =
    raw.summary?.trim() || buildAutoSummary(inferredFamilies, limitations.length > 0);

  const plan: ModPlan = {
    id: normalizedId,
    prompt: normalizedPrompt,
    title,
    summary,
    status,
    families: inferredFamilies
  };

  if (normalizedMechanics) {
    plan.mechanics = normalizedMechanics;
  }
  if (normalizedPresentation) {
    plan.presentation = normalizedPresentation;
  }
  if (normalizedAssetRequests.length > 0) {
    plan.assetRequests = normalizedAssetRequests;
  }
  if (limitations.length > 0) {
    plan.limitations = limitations;
  }

  return { ok: true, plan, dropped };
}

function normalizeFamilies(families: string[], dropped: string[]): MutationFamily[] {
  const normalized: MutationFamily[] = [];
  for (const family of families) {
    if (isMutationFamily(family)) {
      normalized.push(family);
    } else {
      dropped.push(`Unsupported mutation family dropped: ${family}`);
    }
  }
  return dedupe(normalized);
}

function normalizeMechanics(
  mechanics: {
    gravityScale?: number;
    playerMoveScale?: number;
    projectileSpeedScale?: number;
    weaponOverrides?: Array<{
      weaponType: string;
      displayName?: string;
      projectilePreset?: string;
      fireRateScale?: number;
    }>;
  } | undefined,
  dropped: string[]
): ModPlan["mechanics"] | undefined {
  if (!mechanics) {
    return undefined;
  }

  const normalizedWeaponOverrides: WeaponOverride[] = [];
  for (const override of mechanics.weaponOverrides ?? []) {
    if (!isWeaponType(override.weaponType)) {
      dropped.push(`Unsupported weapon target dropped: ${override.weaponType}`);
      continue;
    }

    const normalizedOverride: WeaponOverride = {
      weaponType: override.weaponType
    };
    if (override.displayName?.trim()) {
      normalizedOverride.displayName = override.displayName.trim();
    }
    if (override.projectilePreset) {
      if (isProjectilePreset(override.projectilePreset)) {
        normalizedOverride.projectilePreset = override.projectilePreset;
      } else {
        dropped.push(
          `Unsupported projectile preset dropped: ${override.projectilePreset}`
        );
      }
    }
    const fireRateScale = clampOptional(override.fireRateScale, 0.5, 2);
    if (fireRateScale !== undefined) {
      normalizedOverride.fireRateScale = fireRateScale;
    }
    normalizedWeaponOverrides.push(normalizedOverride);
  }

  const normalized: NonNullable<ModPlan["mechanics"]> = {};
  const gravityScale = clampOptional(mechanics.gravityScale, 0.25, 4);
  const playerMoveScale = clampOptional(mechanics.playerMoveScale, 0.5, 2);
  const projectileSpeedScale = clampOptional(mechanics.projectileSpeedScale, 0.5, 2);

  if (gravityScale !== undefined) {
    normalized.gravityScale = gravityScale;
  }
  if (playerMoveScale !== undefined) {
    normalized.playerMoveScale = playerMoveScale;
  }
  if (projectileSpeedScale !== undefined) {
    normalized.projectileSpeedScale = projectileSpeedScale;
  }
  if (normalizedWeaponOverrides.length > 0) {
    normalized.weaponOverrides = normalizedWeaponOverrides;
  }

  if (Object.keys(normalized).length === 0) {
    return undefined;
  }

  return normalized;
}

function normalizePresentation(
  presentation: {
    screenTint?: string;
    saturationScale?: number;
    uiThemeName?: string;
  } | undefined,
  dropped: string[]
): ModPlan["presentation"] | undefined {
  if (!presentation) {
    return undefined;
  }

  const normalized: NonNullable<ModPlan["presentation"]> = {};

  if (presentation.screenTint) {
    if (isSafeColor(presentation.screenTint)) {
      normalized.screenTint = presentation.screenTint.trim();
    } else {
      dropped.push(`Unsupported screen tint dropped: ${presentation.screenTint}`);
    }
  }

  const saturationScale = clampOptional(presentation.saturationScale, 0.5, 2);
  if (saturationScale !== undefined) {
    normalized.saturationScale = saturationScale;
  }

  if (presentation.uiThemeName?.trim()) {
    normalized.uiThemeName = presentation.uiThemeName.trim();
  }

  if (Object.keys(normalized).length === 0) {
    return undefined;
  }

  return normalized;
}

function normalizeAssetRequests(
  requests:
    | Array<{
        kind: string;
        target: string;
        brief?: string;
        frameBudget?: string;
      }>
    | undefined,
  dropped: string[]
): AssetRequest[] {
  if (!requests || requests.length === 0) {
    return [];
  }

  const normalized: AssetRequest[] = [];
  for (const request of requests) {
    const brief = request.brief?.trim() || "Stylized reinterpretation for DoomGen MVP.";
    switch (request.kind) {
      case "enemy_sprite_set": {
        if (!isEnemyType(request.target)) {
          dropped.push(`Unsupported enemy sprite target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "enemy_sprite_set",
          target: request.target,
          brief,
          frameBudget: "low"
        });
        break;
      }
      case "weapon_sprite_set": {
        if (!isWeaponType(request.target)) {
          dropped.push(`Unsupported weapon sprite target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "weapon_sprite_set",
          target: request.target,
          brief,
          frameBudget: "low"
        });
        break;
      }
      case "pickup_sprite_set": {
        if (!isPickupType(request.target)) {
          dropped.push(`Unsupported pickup sprite target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "pickup_sprite_set",
          target: request.target,
          brief,
          frameBudget: "low"
        });
        break;
      }
      case "projectile_fx_set": {
        if (!isProjectileFxType(request.target)) {
          dropped.push(`Unsupported projectile FX target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "projectile_fx_set",
          target: request.target,
          brief,
          frameBudget: "low"
        });
        break;
      }
      case "hud_patch_set": {
        if (!isHudPatchType(request.target)) {
          dropped.push(`Unsupported HUD patch target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "hud_patch_set",
          target: request.target,
          brief,
          frameBudget: "low"
        });
        break;
      }
      case "wall_texture_set": {
        if (!isWallTextureType(request.target)) {
          dropped.push(`Unsupported wall texture target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "wall_texture_set",
          target: request.target,
          brief,
          frameBudget: "low"
        });
        break;
      }
      case "flat_texture_set": {
        if (!isFlatTextureType(request.target)) {
          dropped.push(`Unsupported flat texture target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "flat_texture_set",
          target: request.target,
          brief,
          frameBudget: "low"
        });
        break;
      }
      case "sound_pack": {
        if (!isEnemyType(request.target) && !isWeaponType(request.target)) {
          dropped.push(`Unsupported sound pack target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "sound_pack",
          target: request.target,
          brief
        });
        break;
      }
      case "music_track": {
        if (request.target !== "level") {
          dropped.push(`Unsupported music target dropped: ${request.target}`);
          continue;
        }
        normalized.push({
          kind: "music_track",
          target: "level",
          brief
        });
        break;
      }
      default:
        dropped.push(`Unsupported asset request dropped: ${request.kind}`);
    }
  }

  return normalized;
}

function filterAssetRequestsForPromptIntent(
  prompt: string,
  requests: AssetRequest[]
): AssetRequest[] {
  if (requests.length === 0) {
    return requests;
  }

  const allowSound = promptExplicitlyRequestsSound(prompt);
  const allowMusic = promptExplicitlyRequestsMusic(prompt);
  const filtered: AssetRequest[] = [];

  for (const request of requests) {
    if (request.kind === "weapon_sprite_set" && !promptMentionsPistolTarget(prompt)) {
      continue;
    }
    if (request.kind === "enemy_sprite_set" && !promptMentionsZombiemanTarget(prompt)) {
      continue;
    }
    if (request.kind === "hud_patch_set" && !promptMentionsDoomguyFaceTarget(prompt)) {
      continue;
    }
    if (request.kind === "sound_pack" && !allowSound) {
      continue;
    }
    if (request.kind === "music_track" && !allowMusic) {
      continue;
    }
    filtered.push(request);
  }

  return filtered;
}

function inferFamilies(
  families: MutationFamily[],
  mechanics: ModPlan["mechanics"] | undefined,
  presentation: ModPlan["presentation"] | undefined,
  assetRequests: AssetRequest[]
): MutationFamily[] {
  const inferred = new Set<MutationFamily>(families);

  if (mechanics) {
    if (
      mechanics.gravityScale !== undefined ||
      mechanics.playerMoveScale !== undefined ||
      mechanics.projectileSpeedScale !== undefined
    ) {
      inferred.add("physics");
    }
    if (mechanics.weaponOverrides && mechanics.weaponOverrides.length > 0) {
      inferred.add("weapon_behavior");
    }
  }

  if (presentation) {
    inferred.add("presentation_fx");
  }

  for (const request of assetRequests) {
    switch (request.kind) {
      case "enemy_sprite_set":
        inferred.add("enemy_visual");
        break;
      case "weapon_sprite_set":
        inferred.add("weapon_visual");
        break;
      case "pickup_sprite_set":
      case "projectile_fx_set":
      case "hud_patch_set":
      case "wall_texture_set":
      case "flat_texture_set":
        inferred.add("presentation_fx");
        break;
      case "sound_pack":
        if (isEnemyType(request.target)) {
          inferred.add("enemy_audio");
        } else {
          inferred.add("weapon_audio");
        }
        break;
      case "music_track":
        inferred.add("music");
        break;
    }
  }

  return Array.from(inferred);
}

function promptExplicitlyRequestsSound(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const audioCueTerms = [
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
    "quiet"
  ];
  if (audioCueTerms.some((token) => normalized.includes(token))) {
    return true;
  }
  if (extractReactiveSoundPhrase(prompt)) {
    return true;
  }
  return [
    /\b(?:sound|audio|sfx|noise|voice)\s+like\s+([a-z0-9][a-z0-9\s,'-]{1,80})\b/,
    /\b(?:make|turn|have)\b.{0,24}\b(?:it|this|that|the\s+\w+)?\b.{0,24}\b(?:sound|audio|sfx|noise|voice)\b.{0,24}\b(?:like|as)\s+([a-z0-9][a-z0-9\s,'-]{1,80})\b/,
    /\b(?:replace|swap|change)\b.{0,24}\b(?:the\s+)?(?:sound|audio|sfx|noise)\b.{0,24}\b(?:with|to)\s+([a-z0-9][a-z0-9\s,'-]{1,80})\b/
  ].some((pattern) => pattern.test(normalized));
}

function extractReactiveSoundPhrase(prompt: string): string | null {
  const normalized = prompt.toLowerCase().trim().split(/\s+/).join(" ");
  const reactiveVisualTerms = [
    "glow",
    "flash",
    "sparkle",
    "shine",
    "glitter",
    "light up",
    "pulse",
    "vibrate",
    "wiggle",
    "open"
  ];
  const patterns = [
    /\b(?:which|that|it)\s+([a-z0-9][a-z0-9\s,'-]{2,80}?)\s+(?:when|whenever|on|every time)\s+(?:shot|fired|fire|shooting|triggered|used)\b/,
    /\b(?:when|whenever|on|every time)\s+(?:shot|fired|fire|shooting|triggered|used)\b.{0,24}\b(?:it|this|that)\s+(?:makes?|does|goes?|lets? out|plays?|emits?)\s+([a-z0-9][a-z0-9\s,'-]{2,80}?)\b/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    const phrase = match[1].trim().replace(/^(?:makes?|does|goes?|lets?\s+out|plays?|emits?)\s+(?:a\s+|an\s+|the\s+)?/, "");
    if (!phrase || reactiveVisualTerms.some((token) => phrase.includes(token))) {
      continue;
    }
    return phrase;
  }
  return null;
}

function promptExplicitlyRequestsMusic(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return [
    "music",
    "soundtrack",
    "song",
    "track",
    "ambient loop",
    "battle theme"
  ].some((token) => normalized.includes(token));
}

function promptMentionsPistolTarget(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const explicitPlayerWeaponPatterns = [
    /\b(?:turn|transform|swap|replace|change|make)\b.{0,40}\b(?:the\s+)?pistol\b/,
    /\b(?:turn|transform|swap|replace|change|make)\b.{0,40}\b(?:the\s+)?(?:player'?s?\s+)?(?:gun|weapon|firearm|sidearm)\b/,
    /\b(?:make|have)\b.{0,24}\b(?:the\s+)?pistol\b.{0,24}\b(?:sound|look|become|turn|transform)\b/,
    /\b(?:the\s+)?pistol\b.{0,40}\b(?:into|with|as|become|look like|sound like|sound)\b/,
    /\b(?:player'?s?\s+)?(?:gun|weapon|firearm|sidearm)\b.{0,40}\b(?:into|with|as|become|look like|sound like)\b/
  ];
  if (explicitPlayerWeaponPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (promptMentionsZombiemanTarget(prompt) && promptHasEnemyScopedPistolMention(normalized)) {
    return false;
  }

  return false;
}

function promptMentionsZombiemanTarget(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("zombieman") || normalized.includes("zombie man")) {
    return true;
  }
  return [
    /(?:turn|transform|swap|replace|change|make).{0,40}\bzombie\b/,
    /\bzombie\b.{0,40}(?:into|with|as|become)\b/
  ].some((pattern) => pattern.test(normalized));
}

function promptMentionsDoomguyFaceTarget(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return [
    "doomguy",
    "doom guy face",
    "hud face",
    "status face",
    "status portrait"
  ].some((token) => normalized.includes(token));
}

function promptHasEnemyScopedPistolMention(normalizedPrompt: string): boolean {
  return [
    /\b(?:zombieman|zombie man|zombie)\b.{0,180}\b(?:with|holding|wielding|carrying|armed with|using|instead of|and)\s+(?:a|an|the)?\s*pistol\b/,
    /\b(?:with|holding|wielding|carrying|armed with|using|instead of|and)\s+(?:a|an|the)?\s*pistol\b.{0,120}\b(?:zombieman|zombie man|zombie)\b/
  ].some((pattern) => pattern.test(normalizedPrompt));
}

function normalizeStatus(status: string | undefined): ModStatus {
  if (!status) {
    return "planning";
  }
  if (isModStatus(status)) {
    return status;
  }
  return "planning";
}

function normalizeTitle(rawTitle: string | undefined, prompt: string): string {
  if (rawTitle?.trim()) {
    return rawTitle.trim();
  }

  const words = prompt
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .slice(0, 5)
    .join(" ");
  return words ? `Mod: ${words}` : "Untitled DoomGen Mod";
}

function buildAutoSummary(families: MutationFamily[], hasLimitations: boolean): string {
  const labels = families.map((family) => family.replaceAll("_", " "));
  const familySummary =
    labels.length === 0
      ? "No supported mutation families found."
      : `Applying ${labels.join(", ")}.`;
  if (hasLimitations) {
    return `${familySummary} Some requests were partially fulfilled.`;
  }
  return familySummary;
}

function isMutationFamily(value: string): value is MutationFamily {
  return (MUTATION_FAMILIES as readonly string[]).includes(value);
}

function isModStatus(value: string): value is ModStatus {
  return (MOD_STATUSES as readonly string[]).includes(value);
}

function isProjectilePreset(value: string): value is ProjectilePreset {
  return (PROJECTILE_PRESETS as readonly string[]).includes(value);
}

function isWeaponType(value: string): value is WeaponType {
  return (WEAPON_TYPES as readonly string[]).includes(value);
}

function isEnemyType(value: string): value is EnemyType {
  return (ENEMY_TYPES as readonly string[]).includes(value);
}

function isPickupType(value: string): value is PickupType {
  return (DOOM1_PICKUP_TYPES as readonly string[]).includes(value);
}

function isProjectileFxType(value: string): value is ProjectileFxType {
  return (DOOM1_PROJECTILE_FX_TYPES as readonly string[]).includes(value);
}

function isHudPatchType(value: string): value is HudPatchType {
  return (DOOM1_HUD_PATCH_TYPES as readonly string[]).includes(value);
}

function isWallTextureType(value: string): value is WallTextureType {
  return (DOOM1_WALL_TEXTURE_TYPES as readonly string[]).includes(value);
}

function isFlatTextureType(value: string): value is FlatTextureType {
  return (DOOM1_FLAT_TEXTURE_TYPES as readonly string[]).includes(value);
}

function isSafeColor(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  const hexColor = /^#([0-9a-fA-F]{3,8})$/;
  const namedColor = /^[a-zA-Z]+$/;
  const rgbLike = /^(rgb|rgba|hsl|hsla)\(/;
  return hexColor.test(normalized) || namedColor.test(normalized) || rgbLike.test(normalized);
}

function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
