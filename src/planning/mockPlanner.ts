import type { AssetRequest, MutationFamily } from "../domain/modPlan";
import { createId } from "../util/id";
import type { Planner } from "./planner";

export class MockPlanner implements Planner {
  async planPrompt(prompt: string): Promise<unknown> {
    await delay(350 + Math.round(Math.random() * 250));

    const normalizedPrompt = prompt.trim();
    const lower = normalizedPrompt.toLowerCase();
    const families = new Set<MutationFamily>();
    const assetRequests: AssetRequest[] = [];
    const limitations: string[] = [];

    const mechanics: {
      gravityScale?: number;
      playerMoveScale?: number;
      projectileSpeedScale?: number;
      weaponOverrides?: Array<{
        weaponType: "pistol";
        displayName?: string;
        projectilePreset?: "bullet" | "hook" | "arcing" | "spread" | "piercing";
        fireRateScale?: number;
      }>;
    } = {};

    const presentation: {
      screenTint?: string;
      saturationScale?: number;
      uiThemeName?: string;
    } = {};

    const includes = (...tokens: string[]): boolean =>
      tokens.some((token) => lower.includes(token));

    const mentionsPistol = includes("pistol", "sidearm", "handgun");
    const mentionsFish = includes("fish", "salmon", "trout", "bass", "carp", "koi");
    const mentionsHorn = includes("car honk", "car horn", "honk", "horn", "beep", "klaxon");
    const mentionsBurp = includes("burp", "belch");

    if (includes("psychedelic", "trippy", "halluc", "acid")) {
      families.add("presentation_fx");
      families.add("music");
      presentation.screenTint = "#ff7f3f";
      presentation.saturationScale = 1.8;
      presentation.uiThemeName = "neon-carnival";
      assetRequests.push({
        kind: "music_track",
        target: "level",
        brief: "A warped, dreamy, high-energy retro track for combat."
      });
    }

    if (includes("underwater", "ocean", "aquatic", "deep sea")) {
      families.add("physics");
      families.add("presentation_fx");
      mechanics.gravityScale = 0.55;
      mechanics.playerMoveScale = 0.8;
      mechanics.projectileSpeedScale = 0.75;
      presentation.screenTint = "#1ba7c9";
      presentation.saturationScale = 0.75;
      presentation.uiThemeName = "submerged";
      assetRequests.push({
        kind: "music_track",
        target: "level",
        brief: "A slow, submerged, pressure-heavy ambient combat loop."
      });
    }

    if (includes("mushroom", "fungus", "spore")) {
      families.add("weapon_behavior");
      families.add("weapon_visual");
      families.add("weapon_audio");
      mechanics.weaponOverrides = [
        {
          weaponType: "pistol",
          displayName: "Mushroom Gun",
          projectilePreset: "arcing",
          fireRateScale: 0.85
        }
      ];
      assetRequests.push({
        kind: "weapon_sprite_set",
        target: "pistol",
        brief:
          "Chunky fungal pistol with spore pods and bioluminescent veins. Low frame budget.",
        frameBudget: "low"
      });
      assetRequests.push({
        kind: "sound_pack",
        target: "pistol",
        brief: "Soft pop, wet thump, and airy spore hiss for each shot."
      });
    }

    if (mentionsPistol && mentionsFish) {
      families.add("weapon_visual");
      assetRequests.push({
        kind: "weapon_sprite_set",
        target: "pistol",
        brief:
          "A fish-themed Doom pistol replacement from the player's eyes in a rear held-weapon FPS view at the bottom center, aimed forward with visible hand grip, muzzle direction, foreshortening, orange scales, fins, and a silly expression.",
        frameBudget: "low"
      });
    }

    if (mentionsPistol && (mentionsHorn || mentionsBurp)) {
      families.add("weapon_audio");
      assetRequests.push({
        kind: "sound_pack",
        target: "pistol",
        brief: mentionsHorn
          ? "Short comedic car-horn blat with a punchy arcade honk and no speech"
          : "Short comedic burping wet pop and no speech"
      });
    }

    if (includes("clay", "squishy", "weird monster", "imp", "monster")) {
      families.add("enemy_visual");
      families.add("enemy_audio");
      assetRequests.push({
        kind: "enemy_sprite_set",
        target: "imp",
        brief:
          "Odd clay-like imp with asymmetrical limbs, hand-molded surface, and gooey motion.",
        frameBudget: "low"
      });
      assetRequests.push({
        kind: "sound_pack",
        target: "imp",
        brief: "Rubbery squeaks, wet growls, and soft collapsing impacts."
      });
    }

    if (includes("faster", "speed up", "fast")) {
      families.add("physics");
      mechanics.playerMoveScale = 1.35;
      mechanics.projectileSpeedScale = 1.2;
    }

    if (includes("slow", "slower", "heavy")) {
      families.add("physics");
      mechanics.playerMoveScale = 0.75;
      mechanics.projectileSpeedScale = 0.7;
      mechanics.gravityScale = 1.5;
    }

    if (includes("hookshot", "grappling", "hook")) {
      families.add("weapon_behavior");
      mechanics.weaponOverrides = [
        {
          weaponType: "pistol",
          displayName: "Hook Pistol",
          projectilePreset: "hook",
          fireRateScale: 0.9
        }
      ];
    }

    if (includes("jump pad", "map edit", "geometry", "new monster class")) {
      limitations.push(
        "World geometry and brand-new monster classes are not supported in this MVP."
      );
    }

    if (families.size === 0) {
      families.add("presentation_fx");
      presentation.screenTint = "#ffa640";
      presentation.saturationScale = 1.1;
      presentation.uiThemeName = "ember";
      limitations.push(
        "Mock planner matched only a lightweight presentation pass for this prompt. Add explicit supported targets like pistol, imp, underwater, psychedelic, mushroom, or hookshot for deterministic test coverage."
      );
    }

    return {
      id: createId("plan"),
      prompt: normalizedPrompt,
      title: buildTitleFromPrompt(normalizedPrompt),
      summary: buildSummary(families, assetRequests),
      status: "planning",
      families: Array.from(families),
      mechanics: Object.keys(mechanics).length === 0 ? undefined : mechanics,
      presentation: Object.keys(presentation).length === 0 ? undefined : presentation,
      assetRequests: assetRequests.length > 0 ? dedupeRequests(assetRequests) : undefined,
      limitations: limitations.length > 0 ? limitations : undefined
    };
  }
}

function buildTitleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "Untitled DoomGen Mod";
  }
  const clipped = cleaned.slice(0, 56);
  return clipped.length === cleaned.length ? clipped : `${clipped}...`;
}

function buildSummary(
  families: Set<MutationFamily>,
  requests: AssetRequest[]
): string {
  const immediateLabels: string[] = [];
  if (families.has("physics")) {
    immediateLabels.push("physics");
  }
  if (families.has("weapon_behavior")) {
    immediateLabels.push("weapon behavior");
  }
  if (families.has("presentation_fx")) {
    immediateLabels.push("presentation FX");
  }

  const pendingLabels: string[] = [];
  if (requests.some((request) => request.kind === "enemy_sprite_set")) {
    pendingLabels.push("enemy art");
  }
  if (requests.some((request) => request.kind === "weapon_sprite_set")) {
    pendingLabels.push("weapon art");
  }
  if (requests.some((request) => request.kind === "sound_pack")) {
    pendingLabels.push("sound pack");
  }
  if (requests.some((request) => request.kind === "music_track")) {
    pendingLabels.push("music");
  }

  if (pendingLabels.length === 0) {
    if (immediateLabels.length === 0) {
      return "Applying safe fallback presentation changes immediately.";
    }
    return `Applying ${immediateLabels.join(", ")} immediately.`;
  }
  if (immediateLabels.length === 0) {
    return `Generating ${pendingLabels.join(", ")} now.`;
  }
  return `Applying ${immediateLabels.join(", ")} now; generating ${pendingLabels.join(", ")} asynchronously.`;
}

function dedupeRequests(requests: AssetRequest[]): AssetRequest[] {
  const seen = new Set<string>();
  const deduped: AssetRequest[] = [];
  for (const request of requests) {
    const key = `${request.kind}:${request.target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(request);
  }
  return deduped;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
