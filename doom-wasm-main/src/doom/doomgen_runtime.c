#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include "doomgen_runtime.h"
#include "doomtype.h"
#include "d_event.h"
#include "doomkeys.h"
#include "d_player.h"
#include "doomstat.h"
#include "info.h"
#include "g_game.h"
#include "v_patch.h"

void P_FireWeapon(player_t *player);

static spritenum_t DoomGen_GetWeaponSpriteManifest(const char *manifestHandle);

#define DOOMGEN_ENEMY_TYPE_COUNT 10

static fixed_t doomgen_gravity_scale = FRACUNIT;
static fixed_t doomgen_projectile_speed_scale = FRACUNIT;
static fixed_t doomgen_player_move_scale = FRACUNIT;
static int doomgen_pistol_projectile_preset = DOOMGEN_PROJECTILE_BULLET;
static fixed_t doomgen_pistol_fire_rate_scale = FRACUNIT;

static char doomgen_enemy_sprite_manifests[DOOMGEN_ENEMY_TYPE_COUNT][128];
static char doomgen_hud_patch_manifests[1][128];
static char doomgen_pistol_sprite_manifest[128];
static char doomgen_weapon_sprite_manifests[NUMWEAPONS][128];
static char doomgen_imp_sound_pack[128];
static char doomgen_weapon_sound_packs[NUMWEAPONS][128];
static char doomgen_level_music[128];

typedef struct
{
    patch_t *patch;
    int length;
} doomgen_runtime_patch_slot_t;

static doomgen_runtime_patch_slot_t doomgen_weapon_runtime_patches[NUMWEAPONS][3];
static boolean doomgen_weapon_runtime_patch_ready[NUMWEAPONS];
static boolean doomgen_weapon_runtime_patch_failure_reported[NUMWEAPONS];
static doomgen_runtime_patch_slot_t doomgen_enemy_runtime_patches
    [DOOMGEN_ENEMY_TYPE_COUNT][DOOMGEN_ZOMBIEMAN_FRAME_COUNT][DOOMGEN_ZOMBIEMAN_ROTATION_COUNT];
static doomgen_runtime_patch_slot_t doomgen_hud_face_runtime_patches[DOOMGEN_HUD_FACE_SLOT_COUNT];

typedef struct
{
    statenum_t state;
    spritenum_t default_sprite;
} pistol_sprite_entry_t;

static pistol_sprite_entry_t PISTOL_SPRITE_STATES[] = {
    {S_PISTOL, SPR_PISG},
    {S_PISTOLDOWN, SPR_PISG},
    {S_PISTOLUP, SPR_PISG},
    {S_PISTOL1, SPR_PISG},
    {S_PISTOL2, SPR_PISG},
    {S_PISTOL3, SPR_PISG},
    {S_PISTOL4, SPR_PISG},
    {S_PISTOLFLASH, SPR_PISF}
};

static boolean doomgen_pistol_sprite_manifest_initialized = false;
static boolean doomgen_pistol_sprite_override_active = false;
static spritenum_t doomgen_pistol_sprite_override = SPR_PISG;
static boolean doomgen_pistol_browser_replacement_ready = false;

static boolean DoomGen_NotifyWeaponSpriteManifest(int weaponType, const char *manifestHandle)
{
#ifdef __EMSCRIPTEN__
    const char *safeHandle = manifestHandle == NULL ? "" : manifestHandle;
    return (boolean) EM_ASM_INT(
        {
            var fn = typeof window !== "undefined" ? window.__doomModSetWeaponSpriteManifest : null;
            if (typeof fn !== "function")
            {
                return 0;
            }

            try
            {
                return fn($0, UTF8ToString($1)) ? 1 : 0;
            }
            catch (_error)
            {
                return 0;
            }
        },
        weaponType,
        safeHandle
    );
#else
    return 0;
#endif
}

static boolean DoomGen_NotifyEnemySpriteManifest(int enemyType, const char *manifestHandle)
{
#ifdef __EMSCRIPTEN__
    const char *safeHandle = manifestHandle == NULL ? "" : manifestHandle;
    return (boolean) EM_ASM_INT(
        {
            var fn = typeof window !== "undefined" ? window.__doomModSetEnemySpriteManifest : null;
            if (typeof fn !== "function")
            {
                return 0;
            }

            try
            {
                return fn($0, UTF8ToString($1)) ? 1 : 0;
            }
            catch (_error)
            {
                return 0;
            }
        },
        enemyType,
        safeHandle
    );
#else
    return 0;
#endif
}

static boolean DoomGen_NotifyHudPatchManifest(int targetType, const char *manifestHandle)
{
#ifdef __EMSCRIPTEN__
    const char *safeHandle = manifestHandle == NULL ? "" : manifestHandle;
    return (boolean) EM_ASM_INT(
        {
            var fn = typeof window !== "undefined" ? window.__doomModSetHudPatchManifest : null;
            if (typeof fn !== "function")
            {
                return 0;
            }

            try
            {
                return fn($0, UTF8ToString($1)) ? 1 : 0;
            }
            catch (_error)
            {
                return 0;
            }
        },
        targetType,
        safeHandle
    );
#else
    return 0;
#endif
}

static boolean DoomGen_NotifyWeaponSoundPack(int weaponType, const char *packHandle)
{
#ifdef __EMSCRIPTEN__
    const char *safeHandle = packHandle == NULL ? "" : packHandle;
    return (boolean) EM_ASM_INT(
        {
            var fn = typeof window !== "undefined" ? window.__doomModSetWeaponSoundPack : null;
            if (typeof fn !== "function")
            {
                return 0;
            }

            try
            {
                return fn($0, UTF8ToString($1)) ? 1 : 0;
            }
            catch (_error)
            {
                return 0;
            }
        },
        weaponType,
        safeHandle
    );
#else
    return 0;
#endif
}

static boolean IsValidSpriteId(int sprite_id)
{
    return sprite_id >= 0 && sprite_id < NUMSPRITES;
}

static spritenum_t DoomGen_ChooseFallbackPistolSprite(const char *manifestHandle)
{
    static const spritenum_t fallback_sprite_cycle[] = {
        SPR_PISG,
        SPR_SHTG,
        SPR_SHTF,
        SPR_PLSG,
        SPR_PLSF,
        SPR_CHGG,
        SPR_CHGF,
        SPR_MISG,
        SPR_MISF
    };
    unsigned int hash = 0;
    unsigned int i;

    for (i = 0; manifestHandle && manifestHandle[i] != '\0'; ++i)
    {
        hash = (hash * 1315423911u) + (unsigned char) manifestHandle[i];
    }

    if (i == 0)
    {
        return SPR_PISG;
    }

    return fallback_sprite_cycle[hash % (sizeof(fallback_sprite_cycle) / sizeof(*fallback_sprite_cycle))];
}

static spritenum_t DoomGen_GetPistolFlashSprite(spritenum_t baseSprite)
{
    switch (baseSprite)
    {
        case SPR_PISG:
            return SPR_PISF;
        case SPR_SHTG:
            return SPR_SHTF;
        case SPR_SHT2:
            return SPR_SHTF;
        case SPR_CHGG:
            return SPR_CHGF;
        case SPR_PLSG:
            return SPR_PLSF;
        case SPR_MISG:
            return SPR_MISF;
        case SPR_BFGG:
            return SPR_BFGF;
        default:
            return SPR_PISF;
    }
}

static spritenum_t DoomGen_ResolvePistolSpriteManifest(const char *manifestHandle)
{
    spritenum_t resolved = SPR_PISG;

    if (manifestHandle != NULL)
    {
        resolved = (spritenum_t) EM_ASM_INT(
            {
                var handle = UTF8ToString($0);
                var mapped = -1;
                var resolver =
                    typeof window !== "undefined" ? window.__doomModResolveWeaponSprite : null;

                if (typeof resolver === "function") {
                    try {
                        mapped = resolver(handle);
                    } catch (_error) {
                        mapped = -1;
                    }
                }

                if (Number.isInteger(mapped) && mapped >= 0) {
                    return mapped;
                }

                return -1;
            },
            manifestHandle
        );

        if (!IsValidSpriteId(resolved))
        {
            resolved = DoomGen_ChooseFallbackPistolSprite(manifestHandle);
        }
    }

    if (!IsValidSpriteId(resolved))
    {
        resolved = SPR_PISG;
    }

    return resolved;
}

static void DoomGen_ApplyPistolSpriteOverride(spritenum_t weaponSprite)
{
    size_t i;

    if (!doomgen_pistol_sprite_manifest_initialized)
    {
        for (i = 0; i < sizeof(PISTOL_SPRITE_STATES) / sizeof(*PISTOL_SPRITE_STATES); ++i)
        {
            PISTOL_SPRITE_STATES[i].default_sprite = states[PISTOL_SPRITE_STATES[i].state].sprite;
        }
        doomgen_pistol_sprite_manifest_initialized = true;
    }

    for (i = 0; i < sizeof(PISTOL_SPRITE_STATES) / sizeof(*PISTOL_SPRITE_STATES); ++i)
    {
        const statenum_t state = PISTOL_SPRITE_STATES[i].state;
        spritenum_t sprite = PISTOL_SPRITE_STATES[i].default_sprite;
        if (doomgen_pistol_sprite_override_active)
        {
            if (state == S_PISTOLFLASH)
            {
                sprite = DoomGen_GetPistolFlashSprite(weaponSprite);
            }
            else
            {
                sprite = weaponSprite;
            }
        }
        states[state].sprite = sprite;
    }
    doomgen_pistol_sprite_override = weaponSprite;
}

static void DoomGen_PreviewWeaponSoundForTest(int weaponType)
{
    const char *pack = DoomGen_GetWeaponSoundPack(weaponType);

    if (DoomGen_PlayWeaponSoundPack(pack))
    {
        return;
    }

    switch (weaponType)
    {
        case wp_fist:
            DoomGen_PlayBuiltinSfx("PUNCH", 127, 128);
            break;
        case wp_pistol:
            DoomGen_PlayBuiltinSfx("PISTOL", 127, 128);
            break;
        case wp_shotgun:
            DoomGen_PlayBuiltinSfx("SHOTGN", 127, 128);
            break;
        case wp_chaingun:
            DoomGen_PlayBuiltinSfx("CHGUN", 127, 128);
            break;
        case wp_missile:
            DoomGen_PlayBuiltinSfx("RLAUNC", 127, 128);
            break;
        case wp_plasma:
            DoomGen_PlayBuiltinSfx("PLASMA", 127, 128);
            break;
        case wp_bfg:
            DoomGen_PlayBuiltinSfx("BFG", 127, 128);
            break;
        case wp_chainsaw:
            DoomGen_PlayBuiltinSfx("SAWHIT", 127, 128);
            break;
        default:
            break;
    }
}

static void DoomGen_ResetPistolSpriteOverride(void)
{
    if (!doomgen_pistol_sprite_manifest_initialized)
    {
        return;
    }

    doomgen_pistol_sprite_override_active = false;
    DoomGen_ApplyPistolSpriteOverride(SPR_PISG);
}

static fixed_t ClampScaleToFixed(double value, double min, double max)
{
    if (value < min)
    {
        value = min;
    }
    else if (value > max)
    {
        value = max;
    }

    return (fixed_t) (value * FRACUNIT);
}

static void StoreString(char *destination, size_t destination_size, const char *source)
{
    if (destination_size == 0)
    {
        return;
    }

    if (source == NULL)
    {
        destination[0] = '\0';
        return;
    }

    strncpy(destination, source, destination_size - 1);
    destination[destination_size - 1] = '\0';
}

static boolean DoomGen_IsValidWeaponType(int weaponType)
{
    return weaponType >= 0 && weaponType < NUMWEAPONS;
}

static boolean DoomGen_IsValidEnemyType(int enemyType)
{
    return enemyType >= 0 && enemyType < DOOMGEN_ENEMY_TYPE_COUNT;
}

static boolean DoomGen_IsValidEnemyFrameId(int frameId)
{
    return frameId >= 0 && frameId < DOOMGEN_ZOMBIEMAN_FRAME_COUNT;
}

static boolean DoomGen_IsValidEnemyRotation(int rotation)
{
    return rotation >= 0 && rotation < DOOMGEN_ZOMBIEMAN_ROTATION_COUNT;
}

static boolean DoomGen_IsValidHudPatchTarget(int targetType)
{
    return targetType == DOOMGEN_HUD_PATCH_DOOMGUY_FACE;
}

static boolean DoomGen_IsValidHudFaceIndex(int faceIndex)
{
    return faceIndex >= 0 && faceIndex < DOOMGEN_HUD_FACE_SLOT_COUNT;
}

static boolean DoomGen_IsValidPatchRole(int patchRole)
{
    return patchRole >= DOOMGEN_WEAPON_PATCH_READY && patchRole <= DOOMGEN_WEAPON_PATCH_FLASH;
}

static void DoomGen_ClearWeaponRuntimePatchSlot(int weaponType, int patchRole)
{
    doomgen_runtime_patch_slot_t *slot;

    if (!DoomGen_IsValidWeaponType(weaponType) || !DoomGen_IsValidPatchRole(patchRole))
    {
        return;
    }

    slot = &doomgen_weapon_runtime_patches[weaponType][patchRole];
    if (slot->patch != NULL)
    {
        free(slot->patch);
        slot->patch = NULL;
    }
    slot->length = 0;
}

static void DoomGen_ClearEnemyRuntimePatchSlot(int enemyType, int frameId, int rotation)
{
    doomgen_runtime_patch_slot_t *slot;

    if (!DoomGen_IsValidEnemyType(enemyType)
        || !DoomGen_IsValidEnemyFrameId(frameId)
        || !DoomGen_IsValidEnemyRotation(rotation))
    {
        return;
    }

    slot = &doomgen_enemy_runtime_patches[enemyType][frameId][rotation];
    if (slot->patch != NULL)
    {
        free(slot->patch);
        slot->patch = NULL;
    }
    slot->length = 0;
}

static void DoomGen_ClearEnemyRuntimePatchTable(int enemyType)
{
    int frame_id;
    int rotation;

    if (!DoomGen_IsValidEnemyType(enemyType))
    {
        return;
    }

    for (frame_id = 0; frame_id < DOOMGEN_ZOMBIEMAN_FRAME_COUNT; ++frame_id)
    {
        for (rotation = 0; rotation < DOOMGEN_ZOMBIEMAN_ROTATION_COUNT; ++rotation)
        {
            DoomGen_ClearEnemyRuntimePatchSlot(enemyType, frame_id, rotation);
        }
    }
}

static void DoomGen_ClearHudFaceRuntimePatchSlot(int faceIndex)
{
    doomgen_runtime_patch_slot_t *slot;

    if (!DoomGen_IsValidHudFaceIndex(faceIndex))
    {
        return;
    }

    slot = &doomgen_hud_face_runtime_patches[faceIndex];
    if (slot->patch != NULL)
    {
        free(slot->patch);
        slot->patch = NULL;
    }
    slot->length = 0;
}

static void DoomGen_RecomputeWeaponRuntimePatchReady(int weaponType)
{
    if (!DoomGen_IsValidWeaponType(weaponType))
    {
        return;
    }

    doomgen_weapon_runtime_patch_ready[weaponType] =
        doomgen_weapon_runtime_patches[weaponType][DOOMGEN_WEAPON_PATCH_READY].patch != NULL;
}

static unsigned int DoomGen_ReadLittleUInt32(const unsigned char *bytes)
{
    return (unsigned int) bytes[0]
        | ((unsigned int) bytes[1] << 8)
        | ((unsigned int) bytes[2] << 16)
        | ((unsigned int) bytes[3] << 24);
}

static unsigned int DoomGen_ReadLittleUInt16(const unsigned char *bytes)
{
    return (unsigned int) bytes[0] | ((unsigned int) bytes[1] << 8);
}

static const char *DoomGen_ValidateRuntimePatchBytesInternal(
    const unsigned char *patchBytes,
    int patchLength,
    int texturecolumn
)
{
    unsigned int width;
    unsigned int height;
    unsigned int header_size;
    unsigned int column_index;

    if (patchBytes == NULL || patchLength < 8)
    {
        return "Generated weapon patch buffer is too short";
    }

    width = DoomGen_ReadLittleUInt16(patchBytes);
    height = DoomGen_ReadLittleUInt16(patchBytes + 2);

    if (width == 0 || height == 0)
    {
        return "Generated weapon patch has zero dimensions";
    }

    header_size = 8u + (width * 4u);
    if (header_size > (unsigned int) patchLength)
    {
        return "Generated weapon patch header exceeds buffer size";
    }

    if (texturecolumn >= 0 && (unsigned int) texturecolumn >= width)
    {
        return "Generated weapon patch texture column is outside patch width";
    }

    for (column_index = 0; column_index < width; ++column_index)
    {
        unsigned int column_offset;
        unsigned int cursor;
        unsigned int guard = 0;

        if (texturecolumn >= 0 && column_index != (unsigned int) texturecolumn)
        {
            continue;
        }

        column_offset = DoomGen_ReadLittleUInt32(patchBytes + 8u + (column_index * 4u));
        if (column_offset < header_size || column_offset >= (unsigned int) patchLength)
        {
            return "Generated weapon patch column offset is outside buffer bounds";
        }

        cursor = column_offset;
        for (;;)
        {
            unsigned int topdelta;
            unsigned int length;

            if (cursor >= (unsigned int) patchLength)
            {
                return "Generated weapon patch column stream is truncated";
            }

            topdelta = patchBytes[cursor];
            if (topdelta == 0xff)
            {
                break;
            }

            if (cursor + 3u >= (unsigned int) patchLength)
            {
                return "Generated weapon patch post header is truncated";
            }

            length = patchBytes[cursor + 1u];
            if (length == 0)
            {
                return "Generated weapon patch post has zero length";
            }

            if (topdelta + length > height)
            {
                return "Generated weapon patch post exceeds patch height";
            }

            if (cursor + 3u + length >= (unsigned int) patchLength)
            {
                return "Generated weapon patch post data is truncated";
            }

            cursor += 4u + length;
            guard += 1;
            if (guard > height + 1u)
            {
                return "Generated weapon patch column stream is malformed";
            }
        }
    }

    return NULL;
}

static void DoomGen_ReportWeaponRuntimePatchFailure(int weaponType, const char *reason)
{
    const char *handle;
    const char *safe_reason;

    if (!DoomGen_IsValidWeaponType(weaponType)
        || doomgen_weapon_runtime_patch_failure_reported[weaponType])
    {
        return;
    }

    doomgen_weapon_runtime_patch_failure_reported[weaponType] = true;
    handle = doomgen_weapon_sprite_manifests[weaponType];
    safe_reason = reason != NULL ? reason : "Generated weapon patch failed validation";

#ifdef __EMSCRIPTEN__
    EM_ASM(
        {
            var runtimeHandle = UTF8ToString($0);
            var runtimeReason = UTF8ToString($1);
            var reporter = typeof window !== "undefined" ? window.__doomModReportRuntimeAssetFailure : null;
            if (runtimeHandle && typeof reporter === "function")
            {
                try
                {
                    reporter(runtimeHandle, runtimeReason);
                    return;
                }
                catch (_error)
                {
                }
            }

            if (typeof console !== "undefined" && typeof console.error === "function")
            {
                console.error("[doom-shell]", runtimeReason);
            }
        },
        handle,
        safe_reason
    );
#else
    (void) handle;
    (void) safe_reason;
#endif
}

static const char *GetWeaponSoundPackHandleByType(int weaponType)
{
    if (DoomGen_IsValidWeaponType(weaponType))
    {
        return doomgen_weapon_sound_packs[weaponType];
    }
    return "";
}

void DoomGen_ResetRuntimeOverrides(void)
{
    int i;
    int patch_role;

    doomgen_gravity_scale = FRACUNIT;
    doomgen_projectile_speed_scale = FRACUNIT;
    doomgen_player_move_scale = FRACUNIT;
    doomgen_pistol_projectile_preset = DOOMGEN_PROJECTILE_BULLET;
    doomgen_pistol_fire_rate_scale = FRACUNIT;

    doomgen_pistol_sprite_manifest[0] = '\0';
    doomgen_imp_sound_pack[0] = '\0';
    doomgen_level_music[0] = '\0';
    doomgen_pistol_browser_replacement_ready = false;

    for (i = 0; i < DOOMGEN_ENEMY_TYPE_COUNT; ++i)
    {
        doomgen_enemy_sprite_manifests[i][0] = '\0';
        DoomGen_ClearEnemyRuntimePatchTable(i);
    }

    doomgen_hud_patch_manifests[DOOMGEN_HUD_PATCH_DOOMGUY_FACE][0] = '\0';
    for (i = 0; i < DOOMGEN_HUD_FACE_SLOT_COUNT; ++i)
    {
        DoomGen_ClearHudFaceRuntimePatchSlot(i);
    }

    for (i = 0; i < NUMWEAPONS; ++i)
    {
        doomgen_weapon_sprite_manifests[i][0] = '\0';
        doomgen_weapon_sound_packs[i][0] = '\0';
        for (patch_role = DOOMGEN_WEAPON_PATCH_READY; patch_role <= DOOMGEN_WEAPON_PATCH_FLASH; ++patch_role)
        {
            DoomGen_ClearWeaponRuntimePatchSlot(i, patch_role);
        }
        doomgen_weapon_runtime_patch_ready[i] = false;
        doomgen_weapon_runtime_patch_failure_reported[i] = false;
    }

    DoomGen_ResetPistolSpriteOverride();
    for (i = 0; i < NUMWEAPONS; ++i)
    {
        DoomGen_NotifyWeaponSpriteManifest(i, "");
        DoomGen_NotifyWeaponSoundPack(i, "");
    }

    for (i = 0; i < DOOMGEN_ENEMY_TYPE_COUNT; ++i)
    {
        DoomGen_NotifyEnemySpriteManifest(i, "");
    }

    DoomGen_NotifyHudPatchManifest(DOOMGEN_HUD_PATCH_DOOMGUY_FACE, "");
}

fixed_t DoomGen_GetGravityValue(void)
{
    return doomgen_gravity_scale;
}

fixed_t DoomGen_ScaleMoveInput(fixed_t value)
{
    return FixedMul(value, doomgen_player_move_scale);
}

fixed_t DoomGen_ScaleProjectileSpeed(fixed_t value)
{
    return FixedMul(value, doomgen_projectile_speed_scale);
}

int DoomGen_ScaleWeaponTics(int tics, int is_pistol)
{
    fixed_t scaled;
    int rounded;

    if (!is_pistol || tics <= 0 || doomgen_pistol_fire_rate_scale == FRACUNIT)
    {
        return tics;
    }

    scaled = FixedDiv(tics * FRACUNIT, doomgen_pistol_fire_rate_scale);
    rounded = scaled >> FRACBITS;
    if ((scaled & (FRACUNIT - 1)) != 0)
    {
        rounded += 1;
    }
    if (rounded < 1)
    {
        rounded = 1;
    }

    return rounded;
}

int DoomGen_GetPistolProjectilePreset(void)
{
    return doomgen_pistol_projectile_preset;
}

fixed_t DoomGen_GetPistolFireRateScale(void)
{
    return doomgen_pistol_fire_rate_scale;
}

void setGravityScale(double value)
{
    doomgen_gravity_scale = ClampScaleToFixed(value, 0.25, 4.0);
}

void setProjectileSpeedScale(double value)
{
    doomgen_projectile_speed_scale = ClampScaleToFixed(value, 0.5, 2.0);
}

void setPlayerMoveScale(double value)
{
    doomgen_player_move_scale = ClampScaleToFixed(value, 0.5, 2.0);
}

void setWeaponBehavior(int weaponType, int preset, double fireRateScale)
{
    if (weaponType != 0)
    {
        return;
    }

    if (preset < DOOMGEN_PROJECTILE_BULLET)
    {
        preset = DOOMGEN_PROJECTILE_BULLET;
    }
    else if (preset > DOOMGEN_PROJECTILE_PIERCING)
    {
        preset = DOOMGEN_PROJECTILE_PIERCING;
    }

    doomgen_pistol_projectile_preset = preset;
    doomgen_pistol_fire_rate_scale = ClampScaleToFixed(fireRateScale, 0.5, 2.0);
}

void setEnemySpriteManifest(int enemyType, const char *manifestHandle)
{
    if (DoomGen_IsValidEnemyType(enemyType))
    {
        StoreString(
            doomgen_enemy_sprite_manifests[enemyType],
            sizeof(doomgen_enemy_sprite_manifests[enemyType]),
            manifestHandle
        );

        if (manifestHandle == NULL || manifestHandle[0] == '\0')
        {
            DoomGen_ClearEnemyRuntimePatchTable(enemyType);
            DoomGen_NotifyEnemySpriteManifest(enemyType, "");
            return;
        }

        if (!DoomGen_NotifyEnemySpriteManifest(enemyType, manifestHandle))
        {
            DoomGen_ClearEnemyRuntimePatchTable(enemyType);
        }
    }
}

void setHudPatchManifest(int targetType, const char *manifestHandle)
{
    if (!DoomGen_IsValidHudPatchTarget(targetType))
    {
        return;
    }

    StoreString(
        doomgen_hud_patch_manifests[targetType],
        sizeof(doomgen_hud_patch_manifests[targetType]),
        manifestHandle
    );

    if (manifestHandle == NULL || manifestHandle[0] == '\0')
    {
        clearHudFaceRuntimePatches();
        DoomGen_NotifyHudPatchManifest(targetType, "");
        return;
    }

    if (!DoomGen_NotifyHudPatchManifest(targetType, manifestHandle))
    {
        clearHudFaceRuntimePatches();
    }
}

void setWeaponSpriteManifest(int weaponType, const char *manifestHandle)
{
    if (DoomGen_IsValidWeaponType(weaponType))
    {
        spritenum_t weaponSprite;

        StoreString(
            doomgen_weapon_sprite_manifests[weaponType],
            sizeof(doomgen_weapon_sprite_manifests[weaponType]),
            manifestHandle
        );
        doomgen_weapon_runtime_patch_failure_reported[weaponType] = false;

        if (weaponType == 1)
        {
            StoreString(doomgen_pistol_sprite_manifest, sizeof(doomgen_pistol_sprite_manifest), manifestHandle);
        }

        if (manifestHandle == NULL || manifestHandle[0] == '\0')
        {
            clearWeaponRuntimePatches(weaponType);
            doomgen_weapon_sprite_manifests[weaponType][0] = '\0';
            if (weaponType == 1)
            {
                doomgen_pistol_sprite_manifest[0] = '\0';
                doomgen_pistol_browser_replacement_ready = false;
                doomgen_pistol_sprite_override_active = false;
                DoomGen_ApplyPistolSpriteOverride(SPR_PISG);
            }
            DoomGen_NotifyWeaponSpriteManifest(weaponType, "");
            return;
        }

        if (DoomGen_NotifyWeaponSpriteManifest(weaponType, manifestHandle))
        {
            clearWeaponRuntimePatches(weaponType);
            if (weaponType == 1)
            {
                doomgen_pistol_browser_replacement_ready = false;
                doomgen_pistol_sprite_manifest[0] = '\0';
                doomgen_pistol_sprite_override_active = false;
                DoomGen_ApplyPistolSpriteOverride(SPR_PISG);
            }
            return;
        }

        if (weaponType != 1)
        {
            return;
        }

        doomgen_pistol_browser_replacement_ready = false;
        weaponSprite = DoomGen_GetWeaponSpriteManifest(manifestHandle);
        doomgen_pistol_sprite_override_active = weaponSprite != SPR_PISG;
        DoomGen_ApplyPistolSpriteOverride(weaponSprite);
    }
}

void setWeaponSpriteReplacementReady(int weaponType, int isReady)
{
    if (DoomGen_IsValidWeaponType(weaponType))
    {
        doomgen_weapon_runtime_patch_ready[weaponType] = isReady != 0;
        if (weaponType == 1)
        {
            doomgen_pistol_browser_replacement_ready = isReady != 0;
        }
    }
}

void clearWeaponRuntimePatches(int weaponType)
{
    int patch_role;

    if (!DoomGen_IsValidWeaponType(weaponType))
    {
        return;
    }

    for (patch_role = DOOMGEN_WEAPON_PATCH_READY; patch_role <= DOOMGEN_WEAPON_PATCH_FLASH; ++patch_role)
    {
        DoomGen_ClearWeaponRuntimePatchSlot(weaponType, patch_role);
    }

    DoomGen_RecomputeWeaponRuntimePatchReady(weaponType);
}

void DoomGen_InvalidateWeaponRuntimePatches(int weaponType, const char *reason)
{
    if (!DoomGen_IsValidWeaponType(weaponType))
    {
        return;
    }

    DoomGen_ReportWeaponRuntimePatchFailure(weaponType, reason);
    clearWeaponRuntimePatches(weaponType);
    setWeaponSpriteReplacementReady(weaponType, 0);
}

int registerWeaponRuntimePatch(
    int weaponType,
    int patchRole,
    const unsigned char *patchBytes,
    int patchLength
)
{
    const char *validation_error;
    doomgen_runtime_patch_slot_t *slot;
    patch_t *copy;

    if (!DoomGen_IsValidWeaponType(weaponType) || !DoomGen_IsValidPatchRole(patchRole))
    {
        return 0;
    }

    if (patchBytes == NULL || patchLength <= 0)
    {
        DoomGen_InvalidateWeaponRuntimePatches(
            weaponType,
            "Generated weapon patch registration received no patch bytes"
        );
        return 0;
    }

    validation_error = DoomGen_ValidateRuntimePatchBytesInternal(patchBytes, patchLength, -1);
    if (validation_error != NULL)
    {
        DoomGen_InvalidateWeaponRuntimePatches(weaponType, validation_error);
        return 0;
    }

    copy = (patch_t *) malloc((size_t) patchLength);
    if (copy == NULL)
    {
        return 0;
    }

    memcpy(copy, patchBytes, (size_t) patchLength);
    slot = &doomgen_weapon_runtime_patches[weaponType][patchRole];
    DoomGen_ClearWeaponRuntimePatchSlot(weaponType, patchRole);
    slot->patch = copy;
    slot->length = patchLength;
    DoomGen_RecomputeWeaponRuntimePatchReady(weaponType);
    return 1;
}

void clearEnemyRuntimePatch(int enemyType)
{
    DoomGen_ClearEnemyRuntimePatchTable(enemyType);
}

void clearHudFaceRuntimePatches(void)
{
    int face_index;

    for (face_index = 0; face_index < DOOMGEN_HUD_FACE_SLOT_COUNT; ++face_index)
    {
        DoomGen_ClearHudFaceRuntimePatchSlot(face_index);
    }
}

int registerEnemyRuntimePatch(
    int enemyType,
    const unsigned char *patchBytes,
    int patchLength
)
{
    clearEnemyRuntimePatch(enemyType);
    return registerEnemyRuntimePatchRole(enemyType, 0, 0, patchBytes, patchLength);
}

int registerEnemyRuntimePatchRole(
    int enemyType,
    int frameId,
    int rotation,
    const unsigned char *patchBytes,
    int patchLength
)
{
    const char *validation_error;
    doomgen_runtime_patch_slot_t *slot;
    patch_t *copy;

    if (!DoomGen_IsValidEnemyType(enemyType)
        || !DoomGen_IsValidEnemyFrameId(frameId)
        || !DoomGen_IsValidEnemyRotation(rotation))
    {
        return 0;
    }

    if (patchBytes == NULL || patchLength <= 0)
    {
        DoomGen_ClearEnemyRuntimePatchSlot(enemyType, frameId, rotation);
        return 0;
    }

    validation_error = DoomGen_ValidateRuntimePatchBytesInternal(patchBytes, patchLength, -1);
    if (validation_error != NULL)
    {
        DoomGen_ClearEnemyRuntimePatchSlot(enemyType, frameId, rotation);
        return 0;
    }

    copy = (patch_t *) malloc((size_t) patchLength);
    if (copy == NULL)
    {
        return 0;
    }

    memcpy(copy, patchBytes, (size_t) patchLength);
    slot = &doomgen_enemy_runtime_patches[enemyType][frameId][rotation];
    DoomGen_ClearEnemyRuntimePatchSlot(enemyType, frameId, rotation);
    slot->patch = copy;
    slot->length = patchLength;
    return 1;
}

int registerHudFaceRuntimePatch(
    int faceIndex,
    const unsigned char *patchBytes,
    int patchLength
)
{
    const char *validation_error;
    doomgen_runtime_patch_slot_t *slot;
    patch_t *copy;

    if (!DoomGen_IsValidHudFaceIndex(faceIndex))
    {
        return 0;
    }

    if (patchBytes == NULL || patchLength <= 0)
    {
        DoomGen_ClearHudFaceRuntimePatchSlot(faceIndex);
        return 0;
    }

    validation_error = DoomGen_ValidateRuntimePatchBytesInternal(patchBytes, patchLength, -1);
    if (validation_error != NULL)
    {
        DoomGen_ClearHudFaceRuntimePatchSlot(faceIndex);
        return 0;
    }

    copy = (patch_t *) malloc((size_t) patchLength);
    if (copy == NULL)
    {
        return 0;
    }

    memcpy(copy, patchBytes, (size_t) patchLength);
    slot = &doomgen_hud_face_runtime_patches[faceIndex];
    DoomGen_ClearHudFaceRuntimePatchSlot(faceIndex);
    slot->patch = copy;
    slot->length = patchLength;
    return 1;
}

void *DoomGen_GetEnemyRuntimePatch(int enemyType, int frameId, int rotation)
{
    if (!DoomGen_IsValidEnemyType(enemyType)
        || !DoomGen_IsValidEnemyFrameId(frameId)
        || !DoomGen_IsValidEnemyRotation(rotation))
    {
        return NULL;
    }
    return doomgen_enemy_runtime_patches[enemyType][frameId][rotation].patch;
}

int DoomGen_GetEnemyRuntimePatchLength(int enemyType, int frameId, int rotation)
{
    if (!DoomGen_IsValidEnemyType(enemyType)
        || !DoomGen_IsValidEnemyFrameId(frameId)
        || !DoomGen_IsValidEnemyRotation(rotation))
    {
        return 0;
    }
    return doomgen_enemy_runtime_patches[enemyType][frameId][rotation].length;
}

void *DoomGen_GetHudFaceRuntimePatch(int faceIndex)
{
    if (!DoomGen_IsValidHudFaceIndex(faceIndex))
    {
        return NULL;
    }
    return doomgen_hud_face_runtime_patches[faceIndex].patch;
}

int DoomGen_GetHudFaceRuntimePatchLength(int faceIndex)
{
    if (!DoomGen_IsValidHudFaceIndex(faceIndex))
    {
        return 0;
    }
    return doomgen_hud_face_runtime_patches[faceIndex].length;
}

void setEnemySoundPack(int enemyType, const char *packHandle)
{
    if (enemyType == 0)
    {
        StoreString(doomgen_imp_sound_pack, sizeof(doomgen_imp_sound_pack), packHandle);
    }
}

void setWeaponSoundPack(int weaponType, const char *packHandle)
{
    if (DoomGen_IsValidWeaponType(weaponType))
    {
        StoreString(
            doomgen_weapon_sound_packs[weaponType],
            sizeof(doomgen_weapon_sound_packs[weaponType]),
            packHandle
        );
        DoomGen_NotifyWeaponSoundPack(weaponType, packHandle);
    }
}

spritenum_t DoomGen_GetWeaponSpriteManifest(const char *manifestHandle)
{
    spritenum_t manifest_sprite;

    if (manifestHandle == NULL || manifestHandle[0] == '\0')
    {
        return SPR_PISG;
    }

    manifest_sprite = DoomGen_ResolvePistolSpriteManifest(manifestHandle);
    if (!IsValidSpriteId(manifest_sprite))
    {
        return SPR_PISG;
    }

    return manifest_sprite;
}

int DoomGen_PlayWeaponSoundPack(const char *packHandle)
{
    if (packHandle == NULL || packHandle[0] == '\0')
    {
        return 0;
    }

#ifdef __EMSCRIPTEN__
    return EM_ASM_INT(
        {
            var fn = typeof window !== "undefined" ? window.__doomModPlayAssetSound : undefined;
            if (typeof fn !== "function")
            {
                return 0;
            }
            try
            {
                return fn(UTF8ToString($0)) ? 1 : 0;
            }
            catch (_error)
            {
                return 0;
            }
        },
        packHandle
    );
#else
    return 0;
#endif
}

int DoomGen_PlayBuiltinSfx(const char *name, int volume, int sep)
{
    if (name == NULL || name[0] == '\0')
    {
        return 0;
    }

#ifdef __EMSCRIPTEN__
    return EM_ASM_INT(
        {
            var fn = typeof window !== "undefined" ? window.__doomModPlayBuiltinSfx : undefined;
            if (typeof fn !== "function")
            {
                return 0;
            }
            try
            {
                return fn(UTF8ToString($0), $1, $2) ? 1 : 0;
            }
            catch (_error)
            {
                return 0;
            }
        },
        name,
        volume,
        sep
    );
#else
    return 0;
#endif
}

const char *DoomGen_GetWeaponSoundPack(int weaponType)
{
    return GetWeaponSoundPackHandleByType(weaponType);
}

void *DoomGen_GetWeaponRuntimePatch(int weaponType, int patchRole)
{
    if (!DoomGen_IsValidWeaponType(weaponType) || !DoomGen_IsValidPatchRole(patchRole))
    {
        return NULL;
    }

    return doomgen_weapon_runtime_patches[weaponType][patchRole].patch;
}

int DoomGen_GetWeaponRuntimePatchLength(int weaponType, int patchRole)
{
    if (!DoomGen_IsValidWeaponType(weaponType) || !DoomGen_IsValidPatchRole(patchRole))
    {
        return 0;
    }

    return doomgen_weapon_runtime_patches[weaponType][patchRole].length;
}

int DoomGen_IsValidRuntimePatchBytes(const void *patchData, int patchLength)
{
    return DoomGen_ValidateRuntimePatchBytesInternal(
        (const unsigned char *) patchData,
        patchLength,
        -1
    ) == NULL;
}

int DoomGen_IsValidRuntimePatchColumn(const void *patchData, int patchLength, int texturecolumn)
{
    return DoomGen_ValidateRuntimePatchBytesInternal(
        (const unsigned char *) patchData,
        patchLength,
        texturecolumn
    ) == NULL;
}

int DoomGen_ShouldHideWeaponPsprites(int readyweapon, int pendingweapon)
{
    (void) readyweapon;
    (void) pendingweapon;
    return 0;
}

int DoomGen_IsWeaponSpriteReplacementReady(int weaponType)
{
    if (DoomGen_IsValidWeaponType(weaponType))
    {
        return doomgen_weapon_runtime_patch_ready[weaponType] ? 1 : 0;
    }

    return 0;
}

void setLevelMusic(const char *trackHandle)
{
    StoreString(doomgen_level_music, sizeof(doomgen_level_music), trackHandle);
}

void resetAllOverrides(void)
{
    DoomGen_ResetRuntimeOverrides();
}

void doomgenStartNewGame(void)
{
    G_DeferedInitNew(sk_medium, 1, 1);
}

void doomgenSendKey(int doomKey, int isPressed)
{
    event_t event;

    memset(&event, 0, sizeof(event));
    event.type = isPressed ? ev_keydown : ev_keyup;
    event.data1 = doomKey;
    D_PostEvent(&event);
}

void doomgenTapKey(int doomKey)
{
    doomgenSendKey(doomKey, 1);
    doomgenSendKey(doomKey, 0);
}

void doomgenFireWeapon(void)
{
    player_t *player = &players[consoleplayer];

    if (player == NULL || player->mo == NULL)
    {
        return;
    }

    if (player->health <= 0 || player->readyweapon == wp_nochange)
    {
        return;
    }

    P_FireWeapon(player);
    DoomGen_PreviewWeaponSoundForTest(player->readyweapon);
}
