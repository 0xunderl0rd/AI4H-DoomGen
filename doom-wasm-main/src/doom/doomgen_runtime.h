#ifndef DOOMGEN_RUNTIME_H
#define DOOMGEN_RUNTIME_H

#include "m_fixed.h"

typedef enum {
    DOOMGEN_PROJECTILE_BULLET = 0,
    DOOMGEN_PROJECTILE_HOOK = 1,
    DOOMGEN_PROJECTILE_ARCING = 2,
    DOOMGEN_PROJECTILE_SPREAD = 3,
    DOOMGEN_PROJECTILE_PIERCING = 4
} doomgen_projectile_preset_t;

typedef enum {
    DOOMGEN_WEAPON_PATCH_READY = 0,
    DOOMGEN_WEAPON_PATCH_ATTACK = 1,
    DOOMGEN_WEAPON_PATCH_FLASH = 2
} doomgen_weapon_patch_role_t;

typedef enum {
    DOOMGEN_ENEMY_PATCH_DEFAULT = 0
} doomgen_enemy_patch_role_t;

#define DOOMGEN_ZOMBIEMAN_FRAME_COUNT 12
#define DOOMGEN_ZOMBIEMAN_ROTATION_COUNT 8
#define DOOMGEN_HUD_FACE_SLOT_COUNT 42
#define DOOMGEN_HUD_PATCH_DOOMGUY_FACE 0

fixed_t DoomGen_GetGravityValue(void);
fixed_t DoomGen_ScaleMoveInput(fixed_t value);
fixed_t DoomGen_ScaleProjectileSpeed(fixed_t value);
int DoomGen_ScaleWeaponTics(int tics, int is_pistol);
int DoomGen_GetPistolProjectilePreset(void);
fixed_t DoomGen_GetPistolFireRateScale(void);
void DoomGen_ResetRuntimeOverrides(void);
int DoomGen_ShouldHideWeaponPsprites(int readyweapon, int pendingweapon);
int DoomGen_IsWeaponSpriteReplacementReady(int weaponType);
void *DoomGen_GetWeaponRuntimePatch(int weaponType, int patchRole);
int DoomGen_GetWeaponRuntimePatchLength(int weaponType, int patchRole);
int DoomGen_IsValidRuntimePatchBytes(const void *patchData, int patchLength);
int DoomGen_IsValidRuntimePatchColumn(const void *patchData, int patchLength, int texturecolumn);
void DoomGen_InvalidateWeaponRuntimePatches(int weaponType, const char *reason);
void *DoomGen_GetEnemyRuntimePatch(int enemyType, int frameId, int rotation);
int DoomGen_GetEnemyRuntimePatchLength(int enemyType, int frameId, int rotation);
void *DoomGen_GetHudFaceRuntimePatch(int faceIndex);
int DoomGen_GetHudFaceRuntimePatchLength(int faceIndex);

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define DOOMGEN_KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define DOOMGEN_KEEPALIVE
#endif

DOOMGEN_KEEPALIVE void setGravityScale(double value);
DOOMGEN_KEEPALIVE void setProjectileSpeedScale(double value);
DOOMGEN_KEEPALIVE void setPlayerMoveScale(double value);
DOOMGEN_KEEPALIVE void setWeaponBehavior(int weaponType, int preset, double fireRateScale);
DOOMGEN_KEEPALIVE void setEnemySpriteManifest(int enemyType, const char *manifestHandle);
DOOMGEN_KEEPALIVE void setHudPatchManifest(int targetType, const char *manifestHandle);
DOOMGEN_KEEPALIVE void setWeaponSpriteManifest(int weaponType, const char *manifestHandle);
DOOMGEN_KEEPALIVE void setWeaponSpriteReplacementReady(int weaponType, int isReady);
DOOMGEN_KEEPALIVE void clearWeaponRuntimePatches(int weaponType);
DOOMGEN_KEEPALIVE int registerWeaponRuntimePatch(
    int weaponType,
    int patchRole,
    const unsigned char *patchBytes,
    int patchLength
);
DOOMGEN_KEEPALIVE void clearEnemyRuntimePatch(int enemyType);
DOOMGEN_KEEPALIVE void clearHudFaceRuntimePatches(void);
DOOMGEN_KEEPALIVE int registerEnemyRuntimePatch(
    int enemyType,
    const unsigned char *patchBytes,
    int patchLength
);
DOOMGEN_KEEPALIVE int registerEnemyRuntimePatchRole(
    int enemyType,
    int frameId,
    int rotation,
    const unsigned char *patchBytes,
    int patchLength
);
DOOMGEN_KEEPALIVE int registerHudFaceRuntimePatch(
    int faceIndex,
    const unsigned char *patchBytes,
    int patchLength
);
DOOMGEN_KEEPALIVE void setEnemySoundPack(int enemyType, const char *packHandle);
DOOMGEN_KEEPALIVE void setWeaponSoundPack(int weaponType, const char *packHandle);
DOOMGEN_KEEPALIVE void setLevelMusic(const char *trackHandle);
DOOMGEN_KEEPALIVE void resetAllOverrides(void);
DOOMGEN_KEEPALIVE void doomgenStartNewGame(void);
DOOMGEN_KEEPALIVE void doomgenSendKey(int doomKey, int isPressed);
DOOMGEN_KEEPALIVE void doomgenTapKey(int doomKey);
DOOMGEN_KEEPALIVE void doomgenFireWeapon(void);
const char *DoomGen_GetWeaponSoundPack(int weaponType);
int DoomGen_PlayWeaponSoundPack(const char *packHandle);
int DoomGen_PlayBuiltinSfx(const char *name, int volume, int sep);

#endif
