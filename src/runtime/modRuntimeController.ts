import type {
  AssetRequest,
  EnemyType,
  ModPlan,
  ModStatus,
  ProjectilePreset,
  ResolvedAssets,
  WeaponType
} from "../domain/modPlan";
import { humanizeContentId } from "../domain/doom1Content";
import { ENEMY_TYPES, WEAPON_TYPES, validateAndNormalizeModPlan } from "../domain/modPlan";
import type { Planner } from "../planning/planner";
import { createId } from "../util/id";
import { AssetGenerator } from "./assetGenerator";
import type { AssetGeneratorLike } from "./assetGenerator";
import type { EngineAdapter } from "./engineAdapter";
import { TicMutationQueue } from "./ticMutationQueue";
import type {
  ActiveModState,
  EffectivePresentation,
  EngineMutation,
  RuntimeModView,
  RuntimeSnapshot
} from "./types";

const DEFAULT_RUNTIME_ASSET_SUPPORT: AssetSupportMatrix = {
  enemySpriteManifest: false,
  weaponSpriteManifest: true,
  pickupSpriteManifest: false,
  projectileFxManifest: false,
  hudPatchManifest: false,
  wallTextureManifest: false,
  flatTextureManifest: false,
  enemySoundPack: false,
  weaponSoundPack: true,
  musicTrack: false
};

type AssetSupportMatrix = {
  enemySpriteManifest: boolean;
  weaponSpriteManifest: boolean;
  pickupSpriteManifest: boolean;
  projectileFxManifest: boolean;
  hudPatchManifest: boolean;
  wallTextureManifest: boolean;
  flatTextureManifest: boolean;
  enemySoundPack: boolean;
  weaponSoundPack: boolean;
  musicTrack: boolean;
};

type RuntimeControllerOptions = {
  planner: Planner;
  adapter: EngineAdapter;
  assetGenerator?: AssetGeneratorLike;
  tickRate?: number;
  runtimeAssetSupport?: AssetSupportMatrix | boolean;
};

const SUPPORT_MESSAGE_BY_KIND: Record<
  AssetRequest["kind"],
  {
    requestMessage: string;
    canaryKey: keyof AssetSupportMatrix;
  }
> = {
  enemy_sprite_set: {
    requestMessage: "Enemy sprite manifest swaps are not yet applied in-browser.",
    canaryKey: "enemySpriteManifest"
  },
  weapon_sprite_set: {
    requestMessage:
      "Weapon sprite swaps are not available in the current runtime.",
    canaryKey: "weaponSpriteManifest"
  },
  pickup_sprite_set: {
    requestMessage: "Pickup sprite swaps are not yet applied in-browser.",
    canaryKey: "pickupSpriteManifest"
  },
  projectile_fx_set: {
    requestMessage: "Projectile FX swaps are not yet applied in-browser.",
    canaryKey: "projectileFxManifest"
  },
  hud_patch_set: {
    requestMessage: "HUD patch swaps are not yet applied in-browser.",
    canaryKey: "hudPatchManifest"
  },
  wall_texture_set: {
    requestMessage: "Wall texture swaps are not yet applied in-browser.",
    canaryKey: "wallTextureManifest"
  },
  flat_texture_set: {
    requestMessage: "Floor and ceiling flat swaps are not yet applied in-browser.",
    canaryKey: "flatTextureManifest"
  },
  sound_pack: {
    requestMessage: "Sound swaps are not yet applied in-browser.",
    canaryKey: "enemySoundPack",
  },
  music_track: {
    requestMessage: "Level music swaps are not yet applied in-browser.",
    canaryKey: "musicTrack"
  }
};

export class ModRuntimeController {
  private planner: Planner;
  private readonly adapter: EngineAdapter;
  private assetGenerator: AssetGeneratorLike;
  private readonly queue: TicMutationQueue;
  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private readonly mods = new Map<string, ActiveModState>();
  private readonly runtimeAssetSupport: AssetSupportMatrix;
  private presentation: EffectivePresentation = {};
  private planningCount = 0;
  private lastError: string | undefined;

  constructor(options: RuntimeControllerOptions) {
    this.planner = options.planner;
    this.adapter = options.adapter;
    this.assetGenerator = options.assetGenerator ?? new AssetGenerator();
    this.queue = new TicMutationQueue(this.adapter, options.tickRate, () => this.emit());
    this.runtimeAssetSupport = normalizeRuntimeAssetSupport(options.runtimeAssetSupport);
    this.queue.start();
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.adapter.attachCanvas(canvas);
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): RuntimeSnapshot {
    const views = Array.from(this.mods.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((mod) => this.toView(mod));

    return {
      planningInFlight: this.planningCount > 0,
      mods: views,
      presentation: this.presentation,
      engine: this.adapter.getDiagnostics(),
      queue: this.queue.getDiagnostics(),
      lastError: this.lastError
    };
  }

  refreshRuntimeState(): void {
    this.recomputeAndApplyEffectiveState();
  }

  setGenerationProviders(next: { planner: Planner; assetGenerator: AssetGeneratorLike }): void {
    this.planner = next.planner;
    this.assetGenerator = next.assetGenerator;
    this.recordLog("generation providers updated");
    this.emit();
  }

  async applyPrompt(prompt: string): Promise<void> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return;
    }

    const modId = createId("mod");
    const createdAt = Date.now();
    this.recordLog(`applyPrompt started: ${modId}`);
    this.mods.set(modId, {
      status: "planning",
      createdAt,
      plan: {
        id: modId,
        prompt: normalizedPrompt,
        title: "Planning...",
        summary: "Interpreting prompt and preparing safe runtime mutations.",
        status: "planning",
        families: []
      },
      assets: [],
      resolved: { modId },
      transientErrors: []
    });
    this.emit();

    this.planningCount += 1;
    this.emit();

    let rawPlan: unknown;
    try {
      rawPlan = await this.planner.planPrompt(normalizedPrompt);
    } catch (error) {
      this.recordLog(`planner failed for ${modId}`);
      this.failMod(modId, `Planner failed: ${errorToMessage(error)}`);
      this.planningCount = Math.max(0, this.planningCount - 1);
      this.emit();
      return;
    }
    this.planningCount = Math.max(0, this.planningCount - 1);

    const validation = validateAndNormalizeModPlan(rawPlan, {
      fallbackId: modId,
      fallbackPrompt: normalizedPrompt
    });
    if (!validation.ok) {
      this.recordLog(`plan validation failed for ${modId}: ${validation.errors.join(" | ")}`);
      this.failMod(modId, `Plan validation failed: ${validation.errors.join(" | ")}`);
      this.emit();
      return;
    }

    const existing = this.mods.get(modId);
    if (!existing) {
      return;
    }

    const normalizedPlan: ModPlan = {
      ...validation.plan,
      id: modId,
      prompt: normalizedPrompt,
      status: "applying"
    };
    existing.plan = normalizedPlan;
    existing.status = "applying";
    existing.transientErrors = [...(normalizedPlan.limitations ?? [])];
    existing.assets = (normalizedPlan.assetRequests ?? []).map((request) => {
      const requestSupport = this.getRequestSupport(request);
      if (requestSupport.canApply) {
        return {
          request,
          status: "pending"
        };
      }

      existing.transientErrors.push(requestSupport.message);
      return {
        request,
        status: "failed",
        error: requestSupport.message
      };
    });
    existing.resolved = { modId };
    this.recomputeResolvedAssetsForMod(existing);

    this.recomputeAndApplyEffectiveState();
    this.emit();

    if (existing.assets.length === 0) {
      existing.status = existing.transientErrors.length > 0 ? "partial" : "complete";
      existing.plan.status = existing.status;
      this.recordLog(`mod ${modId} completed sync: ${existing.status}`);
      this.emit();
      return;
    }

    existing.status = "generating_assets";
    existing.plan.status = "generating_assets";
    this.emit();

    await Promise.allSettled(
      existing.assets.map((_state, index) => this.resolveAsset(modId, index))
    );

    const refreshed = this.mods.get(modId);
    if (!refreshed) {
      return;
    }
    this.updateStatusFromAssetProgress(refreshed);
    this.recomputeAndApplyEffectiveState();
    this.emit();
  }

  removeMod(modId: string): void {
    if (!this.mods.has(modId)) {
      return;
    }
    this.mods.delete(modId);
    this.recomputeAndApplyEffectiveState();
    this.emit();
  }

  reportRuntimeAssetFailure(handle: string, reason: string): void {
    const normalizedHandle = handle.trim();
    const normalizedReason = reason.trim();
    if (!normalizedHandle || !normalizedReason) {
      return;
    }

    for (const mod of this.mods.values()) {
      const asset = mod.assets.find(
        (candidate) => candidate.handle === normalizedHandle && candidate.status === "ready"
      );
      if (!asset) {
        continue;
      }

      asset.status = "failed";
      asset.error = normalizedReason;
      mod.transientErrors = dedupe([...mod.transientErrors, normalizedReason]);
      this.recordLog(`runtime asset failed for ${mod.plan.id}: ${normalizedHandle} -> ${normalizedReason}`);
      this.recomputeResolvedAssetsForMod(mod);
      this.updateStatusFromAssetProgress(mod);
      this.recomputeAndApplyEffectiveState();
      this.emit();
      return;
    }
  }

  reportRuntimeAssetWarning(handle: string, reason: string): void {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      return;
    }
    for (const mod of this.mods.values()) {
      const asset = mod.assets.find((entry) => entry.handle === handle);
      if (!asset) {
        continue;
      }
      mod.transientErrors = dedupe([...mod.transientErrors, normalizedReason]);
      this.recordLog(`runtime asset warning for ${mod.plan.id}: ${handle} -> ${normalizedReason}`);
      this.updateStatusFromAssetProgress(mod);
      this.recomputeAndApplyEffectiveState();
      this.emit();
      return;
    }
  }

  reportAssetProgress(
    modId: string,
    kind: AssetRequest["kind"],
    target: AssetRequest["target"],
    message: string
  ): void {
    const mod = this.mods.get(modId);
    if (!mod) {
      return;
    }
    const asset = mod.assets.find(
      (entry) => entry.request.kind === kind && entry.request.target === target && entry.status === "pending"
    );
    if (!asset) {
      return;
    }
    if (asset.progress === message) {
      return;
    }
    asset.progress = message;
    this.recordLog(`asset progress for ${modId}: ${kind}/${target} -> ${message}`);
    this.emit();
  }

  dispose(): void {
    this.queue.stop();
    this.adapter.dispose();
    this.listeners.clear();
  }

  private async resolveAsset(modId: string, assetIndex: number): Promise<void> {
    const active = this.mods.get(modId);
    if (!active) {
      return;
    }
    const assetState = active.assets[assetIndex];
    if (!assetState) {
      return;
    }
    if (assetState.status !== "pending") {
      return;
    }

    const result = await this.assetGenerator.generate(assetState.request, modId);
    const refreshed = this.mods.get(modId);
    if (!refreshed) {
      return;
    }
    const targetAsset = refreshed.assets[assetIndex];
    if (!targetAsset) {
      return;
    }

    if (result.ok) {
      this.recordLog(
        `asset resolved for ${modId}: ${assetState.request.kind}/${assetState.request.target}`
      );
      targetAsset.status = "ready";
      targetAsset.handle = result.handle;
      targetAsset.progress = undefined;
      if (result.warnings && result.warnings.length > 0) {
        refreshed.transientErrors = dedupe([...refreshed.transientErrors, ...result.warnings]);
      }
    } else {
      this.recordLog(
        `asset failed for ${modId}: ${assetState.request.kind}/${assetState.request.target} -> ${result.error}`
      );
      targetAsset.status = "failed";
      targetAsset.error = result.error;
      targetAsset.progress = undefined;
      refreshed.transientErrors.push(result.error);
    }

    this.recomputeResolvedAssetsForMod(refreshed);
    this.updateStatusFromAssetProgress(refreshed);
    this.recomputeAndApplyEffectiveState();
    this.emit();
  }

  private getRequestSupport(request: AssetRequest): { canApply: boolean; message: string } {
    return supportsRequest(this.runtimeAssetSupport, request);
  }

  private updateStatusFromAssetProgress(mod: ActiveModState): void {
    if (mod.status === "failed") {
      return;
    }

    const pendingCount = mod.assets.filter((asset) => asset.status === "pending").length;
    const failedCount = mod.assets.filter((asset) => asset.status === "failed").length;

    let nextStatus: ModStatus;
    if (pendingCount > 0) {
      nextStatus = "generating_assets";
    } else if (failedCount > 0 || mod.transientErrors.length > 0) {
      nextStatus = "partial";
    } else {
      nextStatus = "complete";
    }

    mod.status = nextStatus;
    mod.plan.status = nextStatus;
    this.recordLog(`mod ${mod.plan.id} status -> ${nextStatus} (pending=${pendingCount}, failed=${failedCount})`);
  }

  private recomputeAndApplyEffectiveState(): void {
    const orderedActiveMods = Array.from(this.mods.values())
      .filter((mod) => canContributeToRuntime(mod.status))
      .sort((a, b) => a.createdAt - b.createdAt);

    const effectiveMechanics = {
      gravityScale: 1,
      playerMoveScale: 1,
      projectileSpeedScale: 1,
      weaponBehavior: new Map<
        WeaponType,
        {
          preset: ProjectilePreset;
          fireRateScale: number;
          displayName?: string;
        }
      >()
    };

    const effectiveAssets = {
      enemySprite: new Map<EnemyType, string>(),
      weaponSprite: new Map<WeaponType, string>(),
      hudPatch: new Map<"doomguy_face", string>(),
      enemySound: new Map<EnemyType, string>(),
      weaponSound: new Map<WeaponType, string>(),
      musicTrack: undefined as string | undefined
    };

    const effectivePresentation: EffectivePresentation = {};

    for (const mod of orderedActiveMods) {
      const mechanics = mod.plan.mechanics;
      if (mechanics) {
        if (mechanics.gravityScale !== undefined) {
          effectiveMechanics.gravityScale = mechanics.gravityScale;
        }
        if (mechanics.playerMoveScale !== undefined) {
          effectiveMechanics.playerMoveScale = mechanics.playerMoveScale;
        }
        if (mechanics.projectileSpeedScale !== undefined) {
          effectiveMechanics.projectileSpeedScale = mechanics.projectileSpeedScale;
        }
        for (const override of mechanics.weaponOverrides ?? []) {
          effectiveMechanics.weaponBehavior.set(override.weaponType, {
            preset: override.projectilePreset ?? "bullet",
            fireRateScale: override.fireRateScale ?? 1,
            displayName: override.displayName
          });
        }
      }

      const presentation = mod.plan.presentation;
      if (presentation) {
        if (presentation.screenTint !== undefined) {
          effectivePresentation.screenTint = presentation.screenTint;
        }
        if (presentation.saturationScale !== undefined) {
          effectivePresentation.saturationScale = presentation.saturationScale;
        }
        if (presentation.uiThemeName !== undefined) {
          effectivePresentation.uiThemeName = presentation.uiThemeName;
        }
      }

      for (const enemySprite of mod.resolved.enemySpriteManifests ?? []) {
        effectiveAssets.enemySprite.set(enemySprite.target, enemySprite.manifestId);
      }
      for (const weaponSprite of mod.resolved.weaponSpriteManifests ?? []) {
        effectiveAssets.weaponSprite.set(weaponSprite.target, weaponSprite.manifestId);
      }
      for (const hudPatch of mod.resolved.hudPatchManifests ?? []) {
        if (hudPatch.target === "doomguy_face") {
          effectiveAssets.hudPatch.set("doomguy_face", hudPatch.manifestId);
        }
      }
      for (const soundPack of mod.resolved.soundPacks ?? []) {
        if (isEnemyTarget(soundPack.target)) {
          effectiveAssets.enemySound.set(soundPack.target, soundPack.packId);
        }
        if (isWeaponTarget(soundPack.target)) {
          effectiveAssets.weaponSound.set(soundPack.target, soundPack.packId);
        }
      }
      for (const musicTrack of mod.resolved.musicTracks ?? []) {
        effectiveAssets.musicTrack = musicTrack.trackId;
      }
    }

    this.presentation = effectivePresentation;

    const mutations: EngineMutation[] = [
      { kind: "resetAllOverrides" },
      { kind: "setGravityScale", value: effectiveMechanics.gravityScale },
      { kind: "setPlayerMoveScale", value: effectiveMechanics.playerMoveScale },
      {
        kind: "setProjectileSpeedScale",
        value: effectiveMechanics.projectileSpeedScale
      }
    ];

    for (const [weaponType, behavior] of effectiveMechanics.weaponBehavior.entries()) {
      mutations.push({
        kind: "setWeaponBehavior",
        weaponType,
        preset: behavior.preset,
        fireRateScale: behavior.fireRateScale,
        displayName: behavior.displayName
      });
    }
    for (const [enemyType, manifestHandle] of effectiveAssets.enemySprite.entries()) {
      if (this.runtimeAssetSupport.enemySpriteManifest) {
        mutations.push({
          kind: "setEnemySpriteManifest",
          enemyType,
          manifestHandle
        });
      }
    }
    for (const [weaponType, manifestHandle] of effectiveAssets.weaponSprite.entries()) {
      if (this.runtimeAssetSupport.weaponSpriteManifest) {
        mutations.push({
          kind: "setWeaponSpriteManifest",
          weaponType,
          manifestHandle
        });
      }
    }
    for (const [target, manifestHandle] of effectiveAssets.hudPatch.entries()) {
      if (this.runtimeAssetSupport.hudPatchManifest) {
        mutations.push({
          kind: "setHudPatchManifest",
          target,
          manifestHandle
        });
      }
    }
    for (const [enemyType, packHandle] of effectiveAssets.enemySound.entries()) {
      if (this.runtimeAssetSupport.enemySoundPack) {
        mutations.push({
          kind: "setEnemySoundPack",
          enemyType,
          packHandle
        });
      }
    }
    for (const [weaponType, packHandle] of effectiveAssets.weaponSound.entries()) {
      if (this.runtimeAssetSupport.weaponSoundPack) {
        mutations.push({
          kind: "setWeaponSoundPack",
          weaponType,
          packHandle
        });
      }
    }
    if (effectiveAssets.musicTrack !== undefined && this.runtimeAssetSupport.musicTrack) {
      mutations.push({
        kind: "setLevelMusic",
        trackHandle: effectiveAssets.musicTrack
      });
    }

    this.queue.replacePending(mutations);
  }

  private failMod(modId: string, reason: string): void {
    const mod = this.mods.get(modId);
    if (!mod) {
      return;
    }
    mod.status = "failed";
    mod.plan.status = "failed";
    mod.transientErrors.push(reason);
    mod.plan.limitations = dedupe([...(mod.plan.limitations ?? []), reason]);
    this.lastError = reason;
    this.recomputeAndApplyEffectiveState();
  }

  private recomputeResolvedAssetsForMod(mod: ActiveModState): void {
    const byBundle = new Map<string, ActiveModState["assets"]>();
    for (const asset of mod.assets) {
      const key = bundleKey(asset.request);
      const bucket = byBundle.get(key) ?? [];
      bucket.push(asset);
      byBundle.set(key, bucket);
    }

    const resolved: ResolvedAssets = { modId: mod.plan.id };
    for (const assets of byBundle.values()) {
      const hasPending = assets.some((asset) => asset.status === "pending");
      const hasFailed = assets.some((asset) => asset.status === "failed");
      if (hasPending || hasFailed) {
        continue;
      }

      for (const asset of assets) {
        if (asset.status !== "ready" || !asset.handle) {
          continue;
        }
        switch (asset.request.kind) {
          case "enemy_sprite_set":
            resolved.enemySpriteManifests = [
              ...(resolved.enemySpriteManifests ?? []).filter(
                (entry) => entry.target !== asset.request.target
              ),
              { target: asset.request.target, manifestId: asset.handle }
            ];
            break;
          case "weapon_sprite_set":
            resolved.weaponSpriteManifests = [
              ...(resolved.weaponSpriteManifests ?? []).filter(
                (entry) => entry.target !== asset.request.target
              ),
              { target: asset.request.target, manifestId: asset.handle }
            ];
            break;
          case "hud_patch_set":
            resolved.hudPatchManifests = [
              ...(resolved.hudPatchManifests ?? []).filter(
                (entry) => entry.target !== asset.request.target
              ),
              { target: asset.request.target, manifestId: asset.handle }
            ];
            break;
          case "sound_pack":
            resolved.soundPacks = [
              ...(resolved.soundPacks ?? []).filter(
                (entry) => entry.target !== asset.request.target
              ),
              { target: asset.request.target, packId: asset.handle }
            ];
            break;
          case "music_track":
            resolved.musicTracks = [{ target: "level", trackId: asset.handle }];
            break;
        }
      }
    }

    mod.resolved = resolved;
  }

  private toView(mod: ActiveModState): RuntimeModView {
    const pendingAssets = mod.assets.filter((asset) => asset.status === "pending").length;
    const failedAssets = mod.assets.filter((asset) => asset.status === "failed").length;
    const resolvedAssets = mod.assets.filter((asset) => asset.status === "ready").length;
    const limitations = dedupe([...(mod.plan.limitations ?? []), ...mod.transientErrors]);
    const pendingDetails = mod.assets
      .filter((asset) => asset.status === "pending")
      .map((asset) => describeAssetProgress(asset, "pending"));
    const readyDetails = mod.assets
      .filter((asset) => asset.status === "ready")
      .map((asset) => describeAssetProgress(asset, "ready"));
    const failedDetails = mod.assets
      .filter((asset) => asset.status === "failed")
      .map((asset) => describeAssetProgress(asset, "failed"));

    return {
      id: mod.plan.id,
      prompt: mod.plan.prompt,
      title: mod.plan.title,
      summary: mod.plan.summary,
      status: mod.status,
      statusText: buildStatusText(mod, pendingAssets, failedAssets),
      families: mod.plan.families,
      limitations,
      pendingAssets,
      failedAssets,
      resolvedAssets,
      pendingDetails,
      readyDetails,
      failedDetails,
      createdAt: mod.createdAt
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private recordLog(message: string): void {
    const entry = `[doom-mod] ${new Date().toISOString()} ${message}`;
    console.info(entry);
    const runtimeWindow = window as unknown as {
      __doomModRuntimeLog?: string[];
      __doomModRuntimeDiagnostics?: { count: number; last: string };
    };
    runtimeWindow.__doomModRuntimeLog = runtimeWindow.__doomModRuntimeLog ?? [];
    runtimeWindow.__doomModRuntimeLog.push(entry);
    runtimeWindow.__doomModRuntimeLog = runtimeWindow.__doomModRuntimeLog.slice(-120);
    runtimeWindow.__doomModRuntimeDiagnostics = {
      count: runtimeWindow.__doomModRuntimeLog.length,
      last: entry
    };
  }
}

function buildStatusText(
  mod: ActiveModState,
  pendingAssets: number,
  failedAssets: number
): string {
  switch (mod.status) {
    case "planning":
      return "Planning mod from prompt.";
    case "applying":
      return "Applying mechanics and presentation changes at the next tic.";
    case "generating_assets":
      {
        const currentProgress = mod.assets.find((asset) => asset.status === "pending" && asset.progress)?.progress;
        if (currentProgress) {
          return `${currentProgress}. ${pendingAssets} generated bundle${
            pendingAssets === 1 ? "" : "s"
          } still pending before the full mod is active.`;
        }
      }
      return `Immediate changes are active; ${pendingAssets} generated bundle${
        pendingAssets === 1 ? "" : "s"
      } still pending before the full mod is active.`;
    case "complete":
      return "All requested changes are active.";
    case "partial":
      const limitationCount = Math.max(mod.transientErrors.length, failedAssets);
      if (limitationCount > 0) {
        return `Applied with fallback to stock assets for ${limitationCount} unresolved bundle${
          limitationCount === 1 ? "" : "s"
        }.`;
      }
      return "Applied with limitations.";
    case "failed":
      return "Mod failed to apply.";
  }
}

function canContributeToRuntime(status: ModStatus): boolean {
  return status !== "planning" && status !== "failed";
}

function normalizeRuntimeAssetSupport(
  input: AssetSupportMatrix | boolean | undefined
): AssetSupportMatrix {
  if (input === undefined || input === true) {
    return {
      enemySpriteManifest: true,
      weaponSpriteManifest: true,
      pickupSpriteManifest: false,
      projectileFxManifest: false,
      hudPatchManifest: false,
      wallTextureManifest: false,
      flatTextureManifest: false,
      enemySoundPack: true,
      weaponSoundPack: true,
      musicTrack: true
    };
  }
  if (input === false) {
    return DEFAULT_RUNTIME_ASSET_SUPPORT;
  }
  return {
    enemySpriteManifest: Boolean(input.enemySpriteManifest),
    weaponSpriteManifest: Boolean(input.weaponSpriteManifest),
    pickupSpriteManifest: Boolean(input.pickupSpriteManifest),
    projectileFxManifest: Boolean(input.projectileFxManifest),
    hudPatchManifest: Boolean(input.hudPatchManifest),
    wallTextureManifest: Boolean(input.wallTextureManifest),
    flatTextureManifest: Boolean(input.flatTextureManifest),
    enemySoundPack: Boolean(input.enemySoundPack),
    weaponSoundPack: Boolean(input.weaponSoundPack),
    musicTrack: Boolean(input.musicTrack)
  };
}

function supportsRequest(
  support: AssetSupportMatrix,
  request: AssetRequest
): { canApply: boolean; message: string } {
  if (request.kind === "enemy_sprite_set" && request.target !== "zombieman") {
    return {
      canApply: false,
      message: "Enemy sprite swaps are currently piloted for zombieman only in this runtime."
    };
  }

  const config = SUPPORT_MESSAGE_BY_KIND[request.kind];
  if (!config) {
    return {
      canApply: true,
      message: ""
    };
  }

  let canary = config.canaryKey;
  if (request.kind === "sound_pack") {
    canary = isEnemyTarget(request.target) ? "enemySoundPack" : "weaponSoundPack";
  }
  if (support[canary]) {
    return {
      canApply: true,
      message: ""
    };
  }

  const details =
    request.kind === "sound_pack"
      ? isEnemyTarget(request.target)
        ? "Enemy sound swaps are not yet applied in-browser."
        : "Weapon sound swaps are not yet applied in-browser."
      : config.requestMessage;
  return {
    canApply: false,
    message: details
  };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function bundleKey(request: AssetRequest): string {
  switch (request.kind) {
    case "enemy_sprite_set":
      return `enemy-sprite:${request.target}`;
    case "weapon_sprite_set":
      return `weapon-sprite:${request.target}`;
    case "pickup_sprite_set":
      return `pickup:${request.target}`;
    case "projectile_fx_set":
      return `projectile:${request.target}`;
    case "hud_patch_set":
      return `hud:${request.target}`;
    case "wall_texture_set":
      return `wall:${request.target}`;
    case "flat_texture_set":
      return `flat:${request.target}`;
    case "sound_pack":
      return isEnemyTarget(request.target)
        ? `enemy-sound:${request.target}`
        : `weapon-sound:${request.target}`;
    case "music_track":
      return `music:${request.target}`;
  }
}

function describeAssetProgress(
  asset: ActiveModState["assets"][number],
  status: "pending" | "ready" | "failed"
): string {
  const { request } = asset;
  const target = humanizeContentId(request.target);
  const prefix =
    status === "pending"
      ? "Generating"
      : status === "ready"
        ? "Ready"
        : "Blocked";

  if (status === "pending" && asset.progress) {
    return asset.progress;
  }

  if (status === "failed" && asset.error) {
    return `${prefix}: ${target} ${describeAssetKindSuffix(request.kind)} failed: ${truncateDetail(asset.error)}`;
  }

  switch (request.kind) {
    case "weapon_sprite_set":
      return `${prefix}: ${target} weapon art`;
    case "enemy_sprite_set":
      if (request.target === "zombieman") {
        return status === "pending"
          ? "Generating: Zombieman base look, rotations, and combat states"
          : status === "ready"
            ? "Ready: Zombieman bundle"
            : "Blocked: Zombieman bundle";
      }
      return `${prefix}: ${target} enemy art`;
    case "pickup_sprite_set":
      return `${prefix}: ${target} pickup art`;
    case "projectile_fx_set":
      return `${prefix}: ${target} FX art`;
    case "hud_patch_set":
      if (request.target === "doomguy_face") {
        return status === "pending"
          ? "Generating: Doomguy face bundle"
          : status === "ready"
            ? "Ready: Doomguy face bundle"
            : "Blocked: Doomguy face bundle";
      }
      return `${prefix}: ${target} HUD art`;
    case "wall_texture_set":
      return `${prefix}: ${target} wall texture`;
    case "flat_texture_set":
      return `${prefix}: ${target} floor or ceiling texture`;
    case "sound_pack":
      return `${prefix}: ${target} sound`;
    case "music_track":
      return `${prefix}: level music`;
  }
}

function describeAssetKindSuffix(kind: AssetRequest["kind"]): string {
  switch (kind) {
    case "weapon_sprite_set":
      return "weapon art";
    case "enemy_sprite_set":
      return "enemy art";
    case "pickup_sprite_set":
      return "pickup art";
    case "projectile_fx_set":
      return "FX art";
    case "hud_patch_set":
      return "HUD art";
    case "wall_texture_set":
      return "wall texture";
    case "flat_texture_set":
      return "floor or ceiling texture";
    case "sound_pack":
      return "sound";
    case "music_track":
      return "music";
  }
}

function truncateDetail(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 220) {
    return normalized;
  }
  return `${normalized.slice(0, 217)}...`;
}

function isEnemyTarget(value: string): value is EnemyType {
  return (ENEMY_TYPES as readonly string[]).includes(value);
}

function isWeaponTarget(value: string): value is WeaponType {
  return (WEAPON_TYPES as readonly string[]).includes(value);
}
