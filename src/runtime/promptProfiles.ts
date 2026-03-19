import type { AssetRequest } from "../domain/modPlan";
import { humanizeContentId } from "../domain/doom1Content";
import { ENEMY_TYPES, WEAPON_TYPES } from "../domain/modPlan";

export type ImageGenerationProfile = {
  model: string;
  size: "1024x1024";
  quality: "low";
  background: "transparent" | "opaque";
  outputFormat: "png" | "jpeg";
  outputCompression?: number;
  moderation: "low";
  n: 1;
};

type WeaponVisualPolicy = {
  replacementMode: "full_swap" | "hybrid";
  handMode: "stock_like_default" | "generated_limb";
  styleMode: "doom_authentic" | "prompt_override";
};

type VisualPromptTraits = {
  subject: string;
  fullDescription: string;
  requiredTraits: string[];
  styleOverride?: string;
};

export function buildImagePrompt(request: AssetRequest): string {
  switch (request.kind) {
    case "weapon_sprite_set":
      return buildWeaponImagePrompt(request);
    case "enemy_sprite_set":
      return buildEnemyImagePrompt(request);
    case "pickup_sprite_set":
      return buildPickupImagePrompt(request);
    case "projectile_fx_set":
      return buildProjectileFxPrompt(request);
    case "hud_patch_set":
      return buildHudPatchPrompt(request);
    case "wall_texture_set":
      return buildWallTexturePrompt(request);
    case "flat_texture_set":
      return buildFlatTexturePrompt(request);
    default:
      return request.brief;
  }
}

export function buildAudioPrompt(request: AssetRequest): string {
  if (request.kind === "sound_pack") {
    const soundBrief = normalizeSoundBrief(request.brief);
    if (isWeaponTarget(request.target)) {
      return clampAudioPrompt([
        soundBrief,
        "single non-speech game sound effect",
        "literal requested sound only",
        "requested sound first",
        "no gunshot or weapon mechanics unless explicitly requested",
        "no speech or narration"
      ]);
    }
    if (isEnemyTarget(request.target)) {
      return clampAudioPrompt([
        soundBrief,
        "single non-speech game sound effect",
        "literal requested sound only",
        "requested sound first",
        "avoid generic monster roar unless explicitly requested",
        "no speech or narration"
      ]);
    }
  }

  return request.brief;
}

export function getImageGenerationProfile(
  request: Extract<
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
  >,
  preferredModel: string
): ImageGenerationProfile {
  if (request.kind === "wall_texture_set" || request.kind === "flat_texture_set") {
    return {
      model: preferredModel,
      size: "1024x1024",
      quality: "low",
      background: "opaque",
      outputFormat: "jpeg",
      outputCompression: 90,
      moderation: "low",
      n: 1
    };
  }

  if (
    request.kind === "weapon_sprite_set" ||
    request.kind === "enemy_sprite_set" ||
    request.kind === "pickup_sprite_set" ||
    request.kind === "projectile_fx_set" ||
    request.kind === "hud_patch_set"
  ) {
    return {
      model: preferredModel,
      size: "1024x1024",
      quality: "low",
      background: "transparent",
      outputFormat: "png",
      moderation: "low",
      n: 1
    };
  }

  return {
    model: preferredModel,
    size: "1024x1024",
    quality: "low",
    background: "opaque",
    outputFormat: "jpeg",
    outputCompression: 90,
    moderation: "low",
    n: 1
  };
}

function buildWeaponImagePrompt(
  request: Extract<AssetRequest, { kind: "weapon_sprite_set" }>
): string {
  const targetLabel = humanizeContentId(request.target);
  const policy = getWeaponVisualPolicy(request);
  const framing =
    request.target === "pistol"
      ? "Show a one-handed rear-held player POV at the bottom center, held like a classic Doom pistol from behind, aimed forward, with the hand clearly gripping it and a visible wrist plus a bit more forearm."
      : "Show a Doom-like first-person rear-held player POV at the bottom center, aimed forward.";
  const replacementInstruction =
    policy.replacementMode === "hybrid"
      ? "Blend the requested object with the original firearm silhouette only because the prompt explicitly asked for a hybrid."
      : `Treat the requested object as the entire visible held object for the ${targetLabel}; full swap by default, not a hybrid with original gun parts, gun-shaped cutouts, muzzle holes, drilled bun barrels, or hidden firearm structure.`;
  const handInstruction =
    policy.handMode === "generated_limb"
      ? "Use the explicitly requested custom hand, paw, claw, or limb from the prompt."
      : "Use a stock-like classic shooter hand with the grip, thumb, fingers, wrist, and a small section of forearm visible.";
  const styleInstruction =
    policy.styleMode === "prompt_override"
      ? "Follow the user-requested art style while keeping the sprite readable in Doom-style gameplay framing."
      : "Use rich painted shading, stronger color variety, vivid but grounded Doom-authentic colors, darker midtones, subtle grime, textured detail, and readable contrast.";
  const firearmNegative =
    policy.replacementMode === "hybrid"
      ? "Keep the silhouette readable after downscaling and palette reduction."
      : "Do not show any original pistol, barrel, muzzle opening, slide, trigger guard, receiver, magazine, or visible metal firearm frame.";

  return [
    request.brief,
    `Render a Doom-authentic first-person replacement sprite for the ${targetLabel}.`,
    replacementInstruction,
    framing,
    handInstruction,
    styleInstruction,
    firearmNegative,
    "Leave generous transparent padding on every edge so the weapon silhouette and muzzle area do not touch or clip against the frame borders.",
    "Keep the muzzle and any firing area fully inside the frame with extra headroom for derived firing states.",
    "Transparent background, no text, no UI, no scenery, no poster layout, no inventory icon, no side-profile product shot, and no object presented as a gun-like hybrid unless explicitly requested.",
    "The image should read cleanly after downscaling and palette reduction."
  ].join(" ");
}

function buildEnemyImagePrompt(
  request: Extract<AssetRequest, { kind: "enemy_sprite_set" }>
): string {
  const targetLabel = humanizeContentId(request.target);
  const traits = parseEnemyVisualTraits(request.brief);
  const styleInstruction = traits.styleOverride
    ? `Follow the ${traits.styleOverride} while keeping the actor readable as a Doom enemy billboard.`
    : "Use rich painted shading, muted earthy colors, darker midtones, subtle grime, and textured Doom-authentic detail.";
  const traitInstruction = traits.requiredTraits.length > 0
    ? `Required visible traits: ${traits.requiredTraits.join(", ")}.`
    : `Primary subject: ${traits.subject}.`;

  return [
    `Render a Doom-authentic replacement actor sprite for the ${targetLabel}.`,
    `The creature should read as ${traits.fullDescription}.`,
    traitInstruction,
    styleInstruction,
    "Center the full creature in frame as a grounded actor billboard, not a first-person weapon or a cinematic portrait.",
    "Use a readable full-body silhouette, clear feet-on-floor grounding, and proportions that survive Doom-style downscaling.",
    "Leave transparent padding on every edge so no limbs, horns, or attack features touch the frame borders.",
    "Transparent background, no text, no UI, no scenery, no player hands, no over-the-shoulder camera.",
    "Prefer a front-facing or three-quarter monster presentation suitable for classic Doom enemy replacement."
  ].join(" ");
}

function buildPickupImagePrompt(
  request: Extract<AssetRequest, { kind: "pickup_sprite_set" }>
): string {
  const targetLabel = humanizeContentId(request.target);

  return [
    request.brief,
    `Render a Doom-style ${targetLabel} pickup sprite as a centered collectible icon for classic FPS gameplay.`,
    "Use a transparent background, strong silhouette, and simple readable shading that survives palette reduction and nearest-neighbor downscaling.",
    "Leave transparent padding around the pickup so it does not touch the image borders.",
    "No scenery, no UI, no player hands, no cinematic angle, no poster composition."
  ].join(" ");
}

function buildProjectileFxPrompt(
  request: Extract<AssetRequest, { kind: "projectile_fx_set" }>
): string {
  const targetLabel = humanizeContentId(request.target);

  return [
    request.brief,
    `Render a Doom-style ${targetLabel} FX sprite concept for classic projectile or muzzle-flash replacement.`,
    "Keep the effect centered with a transparent background, readable high-contrast silhouette, and exaggerated arcade energy.",
    "Leave enough transparent padding so the full effect fits inside the frame without clipping at the borders.",
    "No scenery, no text, no UI, no poster layout."
  ].join(" ");
}

function buildHudPatchPrompt(
  request: Extract<AssetRequest, { kind: "hud_patch_set" }>
): string {
  const targetLabel = humanizeContentId(request.target);

  return [
    request.brief,
    `Render a Doom-style ${targetLabel} HUD patch for the classic status bar.`,
    "Use fixed front-facing patch framing with transparent background, bold readability, and clean edges for palette reduction.",
    "Keep the full patch inset from the frame edges with a small transparent border.",
    "No scenery, no perspective scene composition, no mock monitor frame, no poster layout."
  ].join(" ");
}

function buildWallTexturePrompt(
  request: Extract<AssetRequest, { kind: "wall_texture_set" }>
): string {
  const targetLabel = humanizeContentId(request.target);

  return [
    request.brief,
    `Render a seamless Doom-style wall texture for ${targetLabel}.`,
    "The texture must tile cleanly on all edges, read well at low resolution, and feel appropriate for a classic 1993 Doom environment.",
    "No perspective camera, no floor plane, no UI, no poster framing."
  ].join(" ");
}

function buildFlatTexturePrompt(
  request: Extract<AssetRequest, { kind: "flat_texture_set" }>
): string {
  const targetLabel = humanizeContentId(request.target);

  return [
    request.brief,
    `Render a seamless Doom-style floor or ceiling flat for ${targetLabel}.`,
    "The flat must tile cleanly on all edges and remain readable after palette reduction and nearest-neighbor downscaling.",
    "No perspective scene, no characters, no UI, no poster layout."
  ].join(" ");
}

function isEnemyTarget(value: string): boolean {
  return (ENEMY_TYPES as readonly string[]).includes(value);
}

function isWeaponTarget(value: string): boolean {
  return (WEAPON_TYPES as readonly string[]).includes(value);
}

function getWeaponVisualPolicy(
  request: Extract<AssetRequest, { kind: "weapon_sprite_set" }>
): WeaponVisualPolicy {
  const brief = request.brief.toLowerCase();
  return {
    replacementMode: explicitlyRequestsHybridWeapon(brief) ? "hybrid" : "full_swap",
    handMode: explicitlyRequestsCustomLimb(brief) ? "generated_limb" : "stock_like_default",
    styleMode: explicitlyRequestsArtStyleOverride(brief) ? "prompt_override" : "doom_authentic"
  };
}

function explicitlyRequestsHybridWeapon(brief: string): boolean {
  return (
    brief.includes("hybrid")
    || brief.includes("burger pistol")
    || brief.includes("gun made of")
    || brief.includes("pistol hybrid")
  );
}

function explicitlyRequestsCustomLimb(brief: string): boolean {
  return (
    brief.includes("dog paw")
    || brief.includes("paw")
    || brief.includes("claw")
    || brief.includes("tentacle")
    || brief.includes("hulk arm")
    || brief.includes("robot hand")
    || brief.includes("skeletal hand")
  );
}

function explicitlyRequestsArtStyleOverride(brief: string): boolean {
  return (
    brief.includes("anime")
    || brief.includes("realistic")
    || brief.includes("photoreal")
    || brief.includes("comic")
    || brief.includes("watercolor")
    || brief.includes("clay")
    || brief.includes("lego")
    || brief.includes("cartoon")
    || brief.includes("pixel art")
  );
}

function parseEnemyVisualTraits(brief: string): VisualPromptTraits {
  const normalized = normalizeVisualTraitInput(brief);
  if (!normalized) {
    return {
      subject: "enemy",
      fullDescription: "enemy",
      requiredTraits: []
    };
  }

  const styleOverride = extractExplicitStylePhrase(normalized);
  const descriptionSource = removeStylePhrase(normalized, styleOverride);
  const fullDescription = normalizeTraitPhrase(
    extractReplacementPhrase(descriptionSource, ["zombieman", "zombie", "enemy", "monster"]) || descriptionSource,
    ["zombieman", "zombie", "enemy", "monster", "sprite", "graphic", "appearance"]
  );
  const [subject, requiredTraits] = splitSubjectAndTraits(fullDescription);
  return {
    subject: subject || "enemy",
    fullDescription: fullDescription || subject || "enemy",
    requiredTraits,
    styleOverride: styleOverride ?? undefined
  };
}

function normalizeVisualTraitInput(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractExplicitStylePhrase(brief: string): string | null {
  const stylePatterns = [
    /\bin\s+([a-z0-9][a-z0-9\s-]{2,40}\s+style)\b/i,
    /\b([a-z0-9][a-z0-9\s-]{2,40}\s+style)\b/i,
    /\b(watercolor|anime|comic|photoreal|photorealistic|realistic|clay|lego|pixel art|cartoon)\b/i
  ];
  for (const pattern of stylePatterns) {
    const match = brief.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function removeStylePhrase(brief: string, stylePhrase: string | null): string {
  if (!stylePhrase) {
    return brief;
  }
  const escaped = stylePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return brief
    .replace(new RegExp(`\\bin\\s+${escaped}\\b`, "ig"), "")
    .replace(new RegExp(`\\b${escaped}\\b`, "ig"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReplacementPhrase(brief: string, targets: string[]): string {
  const targetPattern = targets.join("|");
  const patterns = [
    new RegExp(
      String.raw`(?:turn|transform|swap).{0,48}(?:${targetPattern}).{0,20}into\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})`,
      "i"
    ),
    new RegExp(
      String.raw`replace.{0,48}(?:${targetPattern}).{0,20}with\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})`,
      "i"
    ),
    /(?:as)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})/i,
    /(?:into)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})/i
  ];
  for (const pattern of patterns) {
    const match = brief.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return brief.trim();
}

function normalizeTraitPhrase(value: string, removals: string[]): string {
  let candidate = value.trim().toLowerCase();
  candidate = candidate.replace(/\b(it|them|this|that)\b/g, " ");
  for (const token of removals) {
    candidate = candidate.replace(new RegExp(`\\b${token}\\b`, "g"), " ");
  }
  return candidate.replace(/\s+/g, " ").trim().replace(/^[,.;:!? -]+|[,.;:!? -]+$/g, "");
}

function splitSubjectAndTraits(description: string): [string, string[]] {
  if (!description) {
    return ["", []];
  }

  const separators = [" wearing ", " with ", " holding ", " carrying ", " topped with ", " made of ", " made from "];
  for (const separator of separators) {
    if (!description.includes(separator)) {
      continue;
    }
    const [rawSubject, rawRest] = description.split(separator, 1);
    const subject = rawSubject.trim().replace(/[-–—]+$/g, "").trim();
    const prefix = separator.trim();
    const traits = splitTraitSegments(rawRest, prefix);
    return [subject || description, traits];
  }

  return [description, []];
}

function splitTraitSegments(value: string, prefix: string): string[] {
  const cleaned = value.trim().replace(/^[,.;:!? -]+|[,.;:!? -]+$/g, "");
  if (!cleaned) {
    return [];
  }
  if (prefix === "with") {
    return cleaned
      .split(/\s+and\s+|\s+with\s+|,\s*/g)
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => `with ${segment}`);
  }
  return [`${prefix} ${cleaned}`];
}

function clampAudioPrompt(parts: string[]): string {
  const prompt = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .slice(0, 220);
  return prompt;
}

function normalizeSoundBrief(brief: string): string {
  return brief
    .replace(/\bweapon shot\b/gi, "")
    .replace(/\bweapon firing sound\b/gi, "")
    .replace(/\bweapon sound effect\b/gi, "")
    .replace(/\bgeneric gunshot\b/gi, "")
    .replace(/\bgunshot\b/gi, "")
    .replace(/\bpistol blast\b/gi, "")
    .replace(/\bdefault pistol blast\b/gi, "")
    .replace(/\bmonster roar\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.;:\- ]+|[,.;:\- ]+$/g, "");
}
