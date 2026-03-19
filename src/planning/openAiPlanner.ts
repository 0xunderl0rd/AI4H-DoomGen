import { appEnv } from "../config/env";
import {
  DOOM1_FLAT_TEXTURE_TYPES,
  DOOM1_HUD_PATCH_TYPES,
  DOOM1_PICKUP_TYPES,
  DOOM1_PROJECTILE_FX_TYPES,
  DOOM1_WALL_TEXTURE_TYPES,
  ENEMY_TYPES,
  WEAPON_TYPES
} from "../domain/doom1Content";
import type { Planner } from "./planner";

const WEAPON_TARGET_LIST = WEAPON_TYPES.join(", ");
const ENEMY_TARGET_LIST = ENEMY_TYPES.join(", ");
const PICKUP_TARGET_LIST = DOOM1_PICKUP_TYPES.join(", ");
const PROJECTILE_TARGET_LIST = DOOM1_PROJECTILE_FX_TYPES.join(", ");
const HUD_TARGET_LIST = DOOM1_HUD_PATCH_TYPES.join(", ");
const WALL_TARGET_LIST = DOOM1_WALL_TEXTURE_TYPES.join(", ");
const FLAT_TARGET_LIST = DOOM1_FLAT_TEXTURE_TYPES.join(", ");

const PLANNER_SYSTEM_PROMPT = `
You are DoomGen's mod planner.
Return exactly one JSON object with no markdown.
Interpret broad user prompts into a safe mod plan.

Constraints:
- Supported families: physics, weapon_behavior, weapon_visual, weapon_audio, enemy_visual, enemy_audio, music, presentation_fx
- Supported weapon sprite/audio targets: ${WEAPON_TARGET_LIST}
- Supported enemy sprite/audio targets: ${ENEMY_TARGET_LIST}
- Supported pickup sprite targets: ${PICKUP_TARGET_LIST}
- Supported projectile FX targets: ${PROJECTILE_TARGET_LIST}
- Supported HUD patch targets: ${HUD_TARGET_LIST}
- Supported wall texture targets: ${WALL_TARGET_LIST}
- Supported flat texture targets: ${FLAT_TARGET_LIST}
- Supported music target: level
- Only emit audio requests when the user explicitly asks for sonic changes.
- Treat any reactive clause like "which <sound/action> when shot", "that <phrase> on use", or similar "makes/does/goes/emits/plays ..." firing or use behavior as an explicit audio request unless it is clearly visual-only.
- Visual-only prompts must not add sound_pack or music_track requests.
- For sound_pack briefs, describe the literal replacement sound the user asked for in concise descriptor form.
- Do not write briefs like "weapon shot", "gunshot", "pistol blast", or "monster roar" unless the user explicitly asked for those sounds.
- For example, if the user asks for "the pistol should sound like a cartoon horn", the sound_pack brief should be closer to "short cartoon horn blat, no speech" than "cartoon-horn weapon shot".
- Physics ranges:
  - gravityScale: 0.25..4.0
  - playerMoveScale: 0.5..2.0
  - projectileSpeedScale: 0.5..2.0
- Weapon behavior:
  - weaponType: pistol
  - projectilePreset: bullet | hook | arcing | spread | piercing
  - fireRateScale: 0.5..2.0
- Asset request kinds:
  - enemy_sprite_set (target: one of ${ENEMY_TARGET_LIST}, frameBudget: low)
  - weapon_sprite_set (target: one of ${WEAPON_TARGET_LIST}, frameBudget: low)
  - pickup_sprite_set (target: one of ${PICKUP_TARGET_LIST}, frameBudget: low)
  - projectile_fx_set (target: one of ${PROJECTILE_TARGET_LIST}, frameBudget: low)
  - hud_patch_set (target: one of ${HUD_TARGET_LIST}, frameBudget: low)
  - wall_texture_set (target: one of ${WALL_TARGET_LIST}, frameBudget: low)
  - flat_texture_set (target: one of ${FLAT_TARGET_LIST}, frameBudget: low)
  - sound_pack (target: one of ${ENEMY_TARGET_LIST} or ${WEAPON_TARGET_LIST})
  - music_track (target: level)

Output shape:
{
  "id": "string",
  "prompt": "string",
  "title": "string",
  "summary": "string",
  "status": "planning",
  "families": ["..."],
  "mechanics": {
    "gravityScale": number,
    "playerMoveScale": number,
    "projectileSpeedScale": number,
    "weaponOverrides": [
      {
        "weaponType": "pistol",
        "displayName": "string",
        "projectilePreset": "bullet|hook|arcing|spread|piercing",
        "fireRateScale": number
      }
    ]
  },
  "presentation": {
    "screenTint": "string",
    "saturationScale": number,
    "uiThemeName": "string"
  },
  "assetRequests": [
    { "kind": "...", "target": "...", "brief": "string", "frameBudget": "low?" }
  ],
  "limitations": ["string"]
}

Only include fields that are relevant.
Status must be "planning".
`.trim();

type OpenAiPlannerOptions = {
  apiKey?: string;
  model?: string;
};

export class OpenAiPlanner implements Planner {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options?: OpenAiPlannerOptions) {
    this.apiKey = options?.apiKey ?? appEnv.openAiApiKey;
    this.model = options?.model ?? appEnv.openAiModel;
  }

  async planPrompt(prompt: string): Promise<unknown> {
    console.info(`[doom-mod] planning started: ${prompt}`);
    if (!this.apiKey) {
      throw new Error("Missing OpenAI API key");
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PLANNER_SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI planner failed (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI planner returned no content");
    }

    console.info("[doom-mod] planning response captured");
    return parseJson(content);
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
    throw new Error("Planner output did not contain valid JSON");
  }
}
