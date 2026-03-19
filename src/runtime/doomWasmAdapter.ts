import type { EngineAdapter } from "./engineAdapter";
import type { EngineDiagnostics, EngineMutation } from "./types";

export type DoomHookBridge = {
  setGravityScale(value: number): void;
  setProjectileSpeedScale(value: number): void;
  setPlayerMoveScale(value: number): void;
  setWeaponBehavior(
    weaponType: number,
    preset: number,
    fireRateScale: number
  ): void;
  setEnemySpriteManifest(enemyType: number, manifestHandle: string): void;
  setWeaponSpriteManifest(weaponType: number, manifestHandle: string): void;
  setHudPatchManifest(targetType: number, manifestHandle: string): void;
  setEnemySoundPack(enemyType: number, packHandle: string): void;
  setWeaponSoundPack(weaponType: number, packHandle: string): void;
  setLevelMusic(trackHandle: string): void;
  resetAllOverrides(): void;
};

const WEAPON_TYPE_TO_RUNTIME_ID: Record<string, number> = {
  fist: 0,
  pistol: 1,
  shotgun: 2,
  chaingun: 3,
  rocket_launcher: 4,
  plasma_rifle: 5,
  bfg9000: 6,
  chainsaw: 7
};

const ENEMY_TYPE_TO_RUNTIME_ID: Record<string, number> = {
  zombieman: 0,
  shotgun_guy: 1,
  imp: 2,
  demon: 3,
  spectre: 4,
  lost_soul: 5,
  cacodemon: 6,
  baron_of_hell: 7,
  cyberdemon: 8,
  spider_mastermind: 9
};

const PROJECTILE_PRESET_TO_RUNTIME_ID: Record<string, number> = {
  bullet: 0,
  hook: 1,
  arcing: 2,
  spread: 3,
  piercing: 4
};

export class DoomWasmAdapter implements EngineAdapter {
  private readonly liveState: Record<string, string | number> = {};
  private appliedMutations = 0;
  private lastError = "";

  constructor(private readonly hooks: DoomHookBridge) {}

  attachCanvas(_canvas: HTMLCanvasElement): void {
    // Real doom-wasm boot/mount lifecycle should own canvas binding.
  }

  applyMutation(mutation: EngineMutation): void {
    try {
      switch (mutation.kind) {
        case "setGravityScale":
          console.info(
            `[doom-mod] applying ccall setGravityScale(${mutation.value})`
          );
          this.hooks.setGravityScale(mutation.value);
          this.liveState.gravityScale = mutation.value;
          break;
        case "setProjectileSpeedScale":
          console.info(
            `[doom-mod] applying ccall setProjectileSpeedScale(${mutation.value})`
          );
          this.hooks.setProjectileSpeedScale(mutation.value);
          this.liveState.projectileSpeedScale = mutation.value;
          break;
        case "setPlayerMoveScale":
          console.info(
            `[doom-mod] applying ccall setPlayerMoveScale(${mutation.value})`
          );
          this.hooks.setPlayerMoveScale(mutation.value);
          this.liveState.playerMoveScale = mutation.value;
          break;
        case "setWeaponBehavior":
          console.info(
            `[doom-mod] applying ccall setWeaponBehavior(type=${mutation.weaponType}, preset=${mutation.preset}, rate=${mutation.fireRateScale})`
          );
          this.hooks.setWeaponBehavior(
            WEAPON_TYPE_TO_RUNTIME_ID[mutation.weaponType] ?? 0,
            PROJECTILE_PRESET_TO_RUNTIME_ID[mutation.preset] ?? 0,
            mutation.fireRateScale
          );
          this.liveState[`${mutation.weaponType}Preset`] = mutation.preset;
          this.liveState[`${mutation.weaponType}FireRateScale`] = mutation.fireRateScale;
          if (mutation.displayName) {
            this.liveState[`${mutation.weaponType}DisplayName`] = mutation.displayName;
          }
          break;
        case "setEnemySpriteManifest":
          console.info(
            `[doom-mod] applying ccall setEnemySpriteManifest(type=${mutation.enemyType}, handle=${mutation.manifestHandle})`
          );
          this.hooks.setEnemySpriteManifest(
            ENEMY_TYPE_TO_RUNTIME_ID[mutation.enemyType] ?? 0,
            mutation.manifestHandle
          );
          this.liveState[`${mutation.enemyType}SpriteManifest`] = mutation.manifestHandle;
          break;
        case "setWeaponSpriteManifest":
          console.info(
            `[doom-mod] applying ccall setWeaponSpriteManifest(type=${mutation.weaponType}, handle=${mutation.manifestHandle})`
          );
          this.hooks.setWeaponSpriteManifest(
            WEAPON_TYPE_TO_RUNTIME_ID[mutation.weaponType] ?? 0,
            mutation.manifestHandle
          );
          this.liveState[`${mutation.weaponType}SpriteManifest`] = mutation.manifestHandle;
          break;
        case "setHudPatchManifest":
          console.info(
            `[doom-mod] applying ccall setHudPatchManifest(target=${mutation.target}, handle=${mutation.manifestHandle})`
          );
          this.hooks.setHudPatchManifest(0, mutation.manifestHandle);
          this.liveState[`${mutation.target}HudManifest`] = mutation.manifestHandle;
          break;
        case "setEnemySoundPack":
          console.info(
            `[doom-mod] applying ccall setEnemySoundPack(type=${mutation.enemyType}, handle=${mutation.packHandle})`
          );
          this.hooks.setEnemySoundPack(
            ENEMY_TYPE_TO_RUNTIME_ID[mutation.enemyType] ?? 0,
            mutation.packHandle
          );
          this.liveState[`${mutation.enemyType}SoundPack`] = mutation.packHandle;
          break;
        case "setWeaponSoundPack":
          console.info(
            `[doom-mod] applying ccall setWeaponSoundPack(type=${mutation.weaponType}, handle=${mutation.packHandle})`
          );
          this.hooks.setWeaponSoundPack(
            WEAPON_TYPE_TO_RUNTIME_ID[mutation.weaponType] ?? 0,
            mutation.packHandle
          );
          this.liveState[`${mutation.weaponType}SoundPack`] = mutation.packHandle;
          break;
        case "setLevelMusic":
          console.info(`[doom-mod] applying ccall setLevelMusic(${mutation.trackHandle})`);
          this.hooks.setLevelMusic(mutation.trackHandle);
          this.liveState.levelMusic = mutation.trackHandle;
          break;
        case "resetAllOverrides":
          console.info("[doom-mod] applying ccall resetAllOverrides()");
          this.hooks.resetAllOverrides();
          Object.keys(this.liveState).forEach((key) => {
            delete this.liveState[key];
          });
          break;
      }
      this.lastError = "";
      this.appliedMutations += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordError(message);
    }
  }

  private recordError(message: string): void {
    this.lastError = message;
    const windowState = window as unknown as {
      __doomModRuntimeLog?: string[];
    };
    windowState.__doomModRuntimeLog = windowState.__doomModRuntimeLog ?? [];
    const entry = `[doom-mod] ${new Date().toISOString()} mutation error: ${message}`;
    windowState.__doomModRuntimeLog.push(entry);
    windowState.__doomModRuntimeLog = windowState.__doomModRuntimeLog.slice(-120);
    console.error(entry);
  }

  resetAllOverrides(): void {
    this.hooks.resetAllOverrides();
    Object.keys(this.liveState).forEach((key) => {
      delete this.liveState[key];
    });
  }

  getDiagnostics(): EngineDiagnostics {
    return {
      adapterName: "doom-wasm",
      appliedMutations: this.appliedMutations,
      liveState: this.lastError
        ? {
            ...this.liveState,
            lastError: this.lastError
          }
        : { ...this.liveState }
    };
  }

  dispose(): void {}
}
