# DoomGen MVP Technical Design

## Goal

Build a playable Doom experience in the browser where a player can describe a mood, theme, or gameplay idea in natural language and the running game mutates in-session.

Examples:

- "psychedelic mode"
- "make everything feel underwater"
- "turn the pistol into a mushroom gun"
- "make the imps look like weird clay monsters and give them squishy sounds"

The magic is not a settings panel with a few exposed toggles. The magic is the system taking a broad prompt, inferring what the player means, and translating that intent into a safe set of runtime mutations plus async asset generation jobs.

The product is still not "AI rewrites Doom live." The product is "AI plans a mod the engine knows how to apply."

## Product Principle

- The user writes semantic prompts, not low-level commands.
- The LLM is allowed to combine multiple mutation families from one prompt.
- The runtime only accepts allowlisted mutation primitives and validated asset requests.
- Some changes happen immediately; generated media can arrive 30 seconds to several minutes later.
- Lower-fidelity generated visuals are acceptable for MVP if they make the loop practical.

## Engine Choice

Primary base:

- `cloudflare/doom-wasm`

Reference upstream:

- `chocolate-doom/chocolate-doom`

Why stay with Doom:

- browser-ready starting point already exists
- Doom has a richer mutation surface than Wolfenstein for weapons, enemies, audio, and presentation
- Freedoom gives a clean public asset story
- Doom mod vocabulary is familiar and better suited to "interpret a fantasy prompt into a bundle of changes"

Why not switch engines now:

- switching to Wolfenstein would reduce gameplay and content flexibility more than it would reduce implementation risk
- the highest-risk area is runtime asset injection, not basic browser boot
- if the chosen Doom port proves too restrictive, we should evaluate a different Doom port before changing games

## Build Strategy

Fork and modify the Chocolate Doom C source used by `doom-wasm` rather than patching WASM memory from JavaScript.

Why:

- C-side hooks are easier to reason about and maintain
- the JS/WASM boundary becomes an explicit API instead of undocumented memory offsets
- the engine remains debuggable when mutations misbehave

Use a Docker-based Emscripten build for reproducibility, but treat that as infrastructure, not the product.

## MVP Boundary

This MVP is a local/browser prototype that proves the loop:

1. boot Doom in the browser
2. enter a broad prompt
3. get an AI-generated mod plan
4. apply immediate gameplay and presentation changes
5. asynchronously swap in generated assets as they finish

This is enough to validate the concept.

Not required for MVP:

- public hosted service
- secure server-side API key management
- multiplayer
- arbitrary map geometry rewrites
- full custom monsters from scratch
- new weapon slots or inventory systems
- unrestricted engine scripting
- polished sharing/session export

Important scope rule:

- "new weapon" in MVP means reinterpret an existing weapon slot with a new name, art, audio, and supported projectile behavior
- "new enemy look" in MVP means replace the presentation of an existing enemy family, not invent a new monster class

## Core User Flow

1. The player opens the page and starts Doom.
2. The game runs with a base IWAD and the DoomGen runtime adapter.
3. The player opens the AI panel and enters a prompt.
4. A planning call turns that prompt into a validated `ModPlan`.
5. Immediate changes apply at the next engine tic:
   - physics scalars
   - weapon behavior remaps
   - browser-side presentation effects
   - music swap requests if a track is already available
6. Asset generation jobs start in parallel:
   - enemy/weapon sprite sets
   - SFX packs
   - music if generated rather than selected
7. Each target swaps atomically when its full asset bundle is ready.
8. The active mod list shows what is applied, what is still generating, and what failed.

The game may keep running while the panel is open, but that is not a locked UX requirement for the first build. If pointer-lock or text input becomes messy, pausing during prompt entry is acceptable for MVP.

## Supported Mutation Families

The player does not choose from this list. The LLM uses it behind the scenes.

- physics: gravity, move speed, projectile speed
- weapon reinterpretation: rename, visuals, audio, projectile preset, fire cadence scalar
- enemy presentation: visuals, audio, display name
- music: replace or layer track
- presentation FX: screen tint, color grading, HUD text/theme, lightweight post-processing that can be done in the browser overlay

World mutations like jump pads or map annotations are intentionally deferred. They complicate revert behavior and are not necessary to prove the concept.

## Architecture

### Frontend

Use:

- Preact
- Vite
- browser audio/image helpers
- Web Workers where media normalization would block the UI

Responsibilities:

- render the game canvas and AI overlay
- submit prompts and show plan/apply progress
- show active mods and per-mod status
- apply browser-side presentation FX
- keep runtime state for active mods and resolved assets

### Doom Runtime Adapter

This is the core layer between browser code and the engine.

Responsibilities:

- expose a narrow JS API to the WASM module
- queue engine mutations and apply them at tic boundaries
- maintain engine-side override tables for gameplay and asset bindings
- map resolved assets to engine handles
- recompute effective state when mods are added or removed

### AI Planner

For MVP, use a single capable model with structured output.

Why:

- simpler than a classifier plus generator chain
- broad prompts still work if the schema is expressive enough
- less latency and less prompt maintenance for the first build

The planner should:

- interpret broad prompts like "psychedelic mode" into multiple mutation families
- produce a safe `ModPlan`
- produce short human-readable summaries for the UI
- include asset generation briefs for anything that must be rendered or synthesized
- describe limitations when the prompt can only be partially fulfilled

If needed later, add a cheap classification step for caching or routing. It is not required for the first prototype.

## Canonical Runtime Model

The previous design mixed desired assets with resolved URLs. That is not workable. The planner cannot know the final asset URLs or manifests before generation completes.

For MVP, split the problem in two:

- `ModPlan`: what the LLM wants the game to become
- `ResolvedAssets`: the concrete generated files/manifests that satisfy part of that plan

```ts
type ModPlan = {
  id: string;
  prompt: string;
  title: string;
  summary: string;
  status: "planning" | "applying" | "generating_assets" | "complete" | "partial" | "failed";
  families: Array<
    "physics" |
    "weapon_behavior" |
    "weapon_visual" |
    "weapon_audio" |
    "enemy_visual" |
    "enemy_audio" |
    "music" |
    "presentation_fx"
  >;
  mechanics?: {
    gravityScale?: number;           // clamp to [0.25, 4.0]
    playerMoveScale?: number;        // clamp to [0.5, 2.0]
    projectileSpeedScale?: number;   // clamp to [0.5, 2.0]
    weaponOverrides?: Array<{
      weaponType: "pistol";
      displayName?: string;
      projectilePreset?: "bullet" | "hook" | "arcing" | "spread" | "piercing";
      fireRateScale?: number;        // clamp to [0.5, 2.0]
    }>;
  };
  presentation?: {
    screenTint?: string;
    saturationScale?: number;        // clamp to [0.5, 2.0]
    uiThemeName?: string;
  };
  assetRequests?: Array<
    | {
        kind: "enemy_sprite_set";
        target: "imp";
        brief: string;
        frameBudget: "low";
      }
    | {
        kind: "weapon_sprite_set";
        target: "pistol";
        brief: string;
        frameBudget: "low";
      }
    | {
        kind: "sound_pack";
        target: "imp" | "pistol";
        brief: string;
      }
    | {
        kind: "music_track";
        target: "level";
        brief: string;
      }
  >;
  limitations?: string[];
};

type ResolvedAssets = {
  modId: string;
  enemySpriteManifests?: Array<{ target: "imp"; manifestId: string }>;
  weaponSpriteManifests?: Array<{ target: "pistol"; manifestId: string }>;
  soundPacks?: Array<{ target: "imp" | "pistol"; packId: string }>;
  musicTracks?: Array<{ target: "level"; trackId: string }>;
};
```

Example interpretation:

- prompt: "psychedelic mode"
- likely plan:
  - reduce or alter presentation colors
  - request strange music
  - reinterpret the pistol as a mushroom gun
  - request surreal enemy art and audio

The player sees one mod, not a list of low-level toggles.

## Validation Rules

The engine never consumes raw model text.

Enforcement:

- JSON schema validation
- allowlisted enum values
- numeric clamping
- unknown fields dropped
- unsupported targets rejected
- human-readable summary generated for the UI

Partial fulfillment is allowed, but it must be visible. Do not silently skip half the request without telling the player what happened.

Recommended UI summary examples:

- "Applied mushroom-gun behavior and screen tint; enemy art is still generating."
- "Music swap failed; gameplay changes are active."

## Conflict and Revert Model

Keep this simple for MVP.

- last-write-wins for global mechanic fields
- last-write-wins for named asset slots like `pistol` or `imp`
- when a mod is removed, recompute effective state from the remaining active mods

Important simplification:

- only support revert for global settings and named presentation/asset overrides
- do not support world-state mutations that require surgical cleanup

This is why jump pads and map edits are out of scope for the first build.

## Engine Integration Strategy

### Principle

Expose a small set of explicit C hooks and engine-side override tables.

### Tic Boundary Synchronization

Queue JS-originated engine mutations and apply them at the start of the next engine tic. Doom runs at 35 tics per second, so the added latency is negligible and avoids mid-frame state corruption.

### Phase 1 Hooks

- `setGravityScale(value)`
- `setProjectileSpeedScale(value)`
- `setPlayerMoveScale(value)`
- `setWeaponBehavior(weaponType, preset, fireRateScale)`
- `setEnemySpriteManifest(enemyType, manifestHandle)`
- `setWeaponSpriteManifest(weaponType, manifestHandle)`
- `setEnemySoundPack(enemyType, packHandle)`
- `setWeaponSoundPack(weaponType, packHandle)`
- `setLevelMusic(trackHandle)`
- `resetAllOverrides()`

Presentation FX are browser-side and do not require engine hooks.

### First Engine Spike

Before building the full prompt loop, prove these three things manually from a debug panel:

1. gravity can be changed live
2. one weapon behavior override can be changed live
3. one custom sprite set and one custom sound pack can be hot-swapped at runtime

If sprite hot-swap is painful, keep moving with mechanics plus audio plus browser-side presentation effects and return to visuals after the loop works.

## Asset Generation Strategy

### Visuals

Do not aim for full Doom-quality sprite coverage in MVP.

Use intentionally lower-fidelity generated visuals:

- low frame count
- low angle count
- mirrored frames where acceptable
- downscaled or simplified output after generation

Practical targets:

- one enemy family: `imp`
- one weapon family: `pistol`
- enough frames to feel alive, not enough to perfectly match a handcrafted sprite sheet

This keeps generation time and integration complexity under control while preserving the "the game changed" effect.

### Audio

Use ElevenLabs or similar for a very small sound surface:

- pistol shot
- imp sight
- imp death

Normalize audio client-side or in a worker if needed. Keep this path simple and deterministic.

### Music

Music can be generated, selected from a style prompt, or played through browser audio if engine-level replacement is awkward.

Do not block the rest of the mod on music integration.

### Asset Timing

Media generation can take from tens of seconds to several minutes. That is acceptable.

Rules:

- mechanics and presentation changes should apply first
- asset swaps should happen atomically per target
- UI should show progress clearly

## Caching

Do not make IndexedDB a day-one requirement.

Recommended sequence:

- first build: in-memory cache only
- second pass: IndexedDB for local persistence keyed by normalized intent plus target plus style brief

Caching should help repeated prompts, but it should not block the first playable build.

## UI Shape

Minimum useful UI:

- full-screen game canvas
- AI prompt button
- prompt panel with textarea and apply action
- active mod list
- per-mod status text

Useful statuses:

- planning
- applying mechanics
- generating assets
- complete
- partial
- failed

The player should always be able to tell:

- what the system thinks the mod is
- what is already active
- what is still pending
- what failed

## Licensing and Assets

- keep project code GPL-2.0 compatible with the Doom codebase
- use Freedoom for public/open distribution
- use Doom shareware only for local validation if needed

Keep the runtime mod system independent from the mounted IWAD.

## Implementation Milestones

### Milestone 0: Browser Doom Boot

- fork `cloudflare/doom-wasm`
- pin an Emscripten build path
- boot with Freedoom assets
- document startup and asset mount flow

Acceptance:

- Doom launches in the browser from the local dev setup

### Milestone 1: Runtime Mutation Spike

- add C-side hooks for physics and weapon behavior
- add engine-side override tables
- build a debug panel for manual hook invocation
- prove one sprite hot-swap and one sound hot-swap

Acceptance:

- gravity and pistol behavior can change live
- one custom imp or pistol asset set can be applied without reloading

### Milestone 2: Prompt-to-Plan Loop

- build the Preact overlay
- send prompts to one structured-output model
- validate and clamp `ModPlan`
- apply mechanics and presentation effects from the plan
- show plan summary and status in the UI

Acceptance:

- a broad prompt like "psychedelic mode" results in a coherent applied plan, even before media finishes

### Milestone 3: Async Media Integration

- generate low-fidelity enemy and weapon visuals
- generate a small sound pack
- wire music replacement or browser playback
- bind resolved assets back into active mods

Acceptance:

- a prompt can update gameplay immediately and later swap in visuals/audio without reloading

### Milestone 4: Persistence and Polish

- add local caching beyond memory if needed
- improve mod removal/recompute flow
- tighten prompts and summaries

Acceptance:

- repeated prompts are faster and the mod list remains understandable across multiple active mods

## Risks and Clarity Needed

### Runtime Visual Injection

The main technical risk is not LLM planning. It is proving that the chosen Doom port can hot-swap generated sprite data cleanly enough for the effect to feel real.

Action:

- treat this as the first technical gate

### Public vs Local MVP

This document assumes a local/browser prototype with developer-provided API keys. That is fine for a build attempt, but it is not a shippable public browser product.

Action:

- keep the first build local
- add a backend later if this becomes something others should use directly

### Weapon Semantics

"Mushroom gun" and similar prompts must map onto an existing weapon slot. That needs to be explicit so Codex does not attempt to invent a new inventory/weapon architecture in the first pass.

Action:

- restrict MVP weapon mutations to the pistol slot first

### Partial Fulfillment

Broad prompts will often ask for more than the runtime can do.

Action:

- allow partial plans
- require visible summaries of what was applied and what is still pending

## First Build Decisions

These should be treated as current implementation decisions:

- stay with Doom and `cloudflare/doom-wasm`
- keep the runtime contract data-driven, never executable code
- use one capable structured-output LLM call for MVP
- support broad prompts that decompose into multiple mutation families
- limit runtime targets to one enemy family (`imp`) and one weapon family (`pistol`) at first
- prefer low-fidelity generated sprite sets to reduce generation time
- allow async media generation to take minutes if needed
- start with in-memory caching only
- defer world mutations and advanced map logic

## Summary

The simplest buildable version of DoomGen is:

- browser Doom running on `doom-wasm`
- a small C-hook runtime adapter
- one LLM planning call that turns broad prompts into a safe `ModPlan`
- immediate application of gameplay and presentation changes
- async generation of low-fidelity art, audio, and music
- atomic media swap-in when assets are ready

That keeps the semantic "magic" while removing unnecessary complexity from the first build.
