import type { DoomHookBridge } from "./doomWasmAdapter";

type EmscriptenModuleLike = {
  ccall: (
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: Array<string | number>
  ) => unknown;
};

export function createEmscriptenHookBridge(module: EmscriptenModuleLike): DoomHookBridge {
  return {
    setGravityScale: (value) => {
      module.ccall("setGravityScale", null, ["number"], [value]);
    },
    setProjectileSpeedScale: (value) => {
      module.ccall("setProjectileSpeedScale", null, ["number"], [value]);
    },
    setPlayerMoveScale: (value) => {
      module.ccall("setPlayerMoveScale", null, ["number"], [value]);
    },
    setWeaponBehavior: (weaponType, preset, fireRateScale) => {
      module.ccall(
        "setWeaponBehavior",
        null,
        ["number", "number", "number"],
        [weaponType, preset, fireRateScale]
      );
    },
    setEnemySpriteManifest: (enemyType, manifestHandle) => {
      module.ccall(
        "setEnemySpriteManifest",
        null,
        ["number", "string"],
        [enemyType, manifestHandle]
      );
    },
    setWeaponSpriteManifest: (weaponType, manifestHandle) => {
      module.ccall(
        "setWeaponSpriteManifest",
        null,
        ["number", "string"],
        [weaponType, manifestHandle]
      );
    },
    setHudPatchManifest: (targetType, manifestHandle) => {
      module.ccall(
        "setHudPatchManifest",
        null,
        ["number", "string"],
        [targetType, manifestHandle]
      );
    },
    setEnemySoundPack: (enemyType, packHandle) => {
      module.ccall("setEnemySoundPack", null, ["number", "string"], [enemyType, packHandle]);
    },
    setWeaponSoundPack: (weaponType, packHandle) => {
      module.ccall(
        "setWeaponSoundPack",
        null,
        ["number", "string"],
        [weaponType, packHandle]
      );
    },
    setLevelMusic: (trackHandle) => {
      module.ccall("setLevelMusic", null, ["string"], [trackHandle]);
    },
    resetAllOverrides: () => {
      module.ccall("resetAllOverrides", null, [], []);
    }
  };
}
