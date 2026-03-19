export const WEAPON_TYPES = [
  "fist",
  "pistol",
  "shotgun",
  "chaingun",
  "rocket_launcher",
  "plasma_rifle",
  "bfg9000",
  "chainsaw"
] as const;

export const ENEMY_TYPES = [
  "zombieman",
  "shotgun_guy",
  "imp",
  "demon",
  "spectre",
  "lost_soul",
  "cacodemon",
  "baron_of_hell",
  "cyberdemon",
  "spider_mastermind"
] as const;

export const MUSIC_TARGETS = ["level"] as const;

export const DOOM1_PICKUP_TYPES = [
  "stimpack",
  "medikit",
  "health_bonus",
  "armor_bonus",
  "green_armor",
  "blue_armor",
  "soulsphere",
  "berserk",
  "invulnerability",
  "invisibility",
  "radiation_suit",
  "computer_map",
  "light_amp_goggles",
  "blue_keycard",
  "yellow_keycard",
  "red_keycard",
  "blue_skull_key",
  "yellow_skull_key",
  "red_skull_key",
  "ammo_clip",
  "ammo_box",
  "shells",
  "shell_box",
  "rocket",
  "rocket_box",
  "cell",
  "cell_pack",
  "shotgun_pickup",
  "chaingun_pickup",
  "rocket_launcher_pickup",
  "plasma_rifle_pickup",
  "bfg9000_pickup",
  "chainsaw_pickup"
] as const;

export const DOOM1_HUD_PATCH_TYPES = [
  "status_bar",
  "doomguy_face",
  "health_digits",
  "armor_digits",
  "ammo_digits",
  "weapon_slots",
  "key_icons"
] as const;

export const DOOM1_PROJECTILE_FX_TYPES = [
  "bullet_puff",
  "pistol_muzzle_flash",
  "shotgun_muzzle_flash",
  "chaingun_muzzle_flash",
  "rocket_projectile",
  "rocket_explosion",
  "plasma_projectile",
  "plasma_impact",
  "bfg_projectile",
  "bfg_explosion"
] as const;

export const DOOM1_WALL_TEXTURE_TYPES = [
  "startan_wall",
  "tech_panel",
  "metal_wall",
  "stone_wall",
  "hell_brick",
  "computer_wall",
  "door_track",
  "exit_signage"
] as const;

export const DOOM1_FLAT_TEXTURE_TYPES = [
  "tech_floor",
  "metal_floor",
  "stone_floor",
  "lava_flat",
  "slime_flat",
  "nukage_flat",
  "ceiling_light",
  "hell_floor"
] as const;

export const DOOM1_CONTENT_MATRIX = {
  weapons: WEAPON_TYPES,
  enemies: ENEMY_TYPES,
  pickups: DOOM1_PICKUP_TYPES,
  projectiles: DOOM1_PROJECTILE_FX_TYPES,
  hud: DOOM1_HUD_PATCH_TYPES,
  wallTextures: DOOM1_WALL_TEXTURE_TYPES,
  flatTextures: DOOM1_FLAT_TEXTURE_TYPES
} as const;

export function humanizeContentId(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
