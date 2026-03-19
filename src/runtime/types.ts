import type {
  ModPlan,
  ModStatus,
  MutationFamily,
  ResolvedAssets,
  WeaponType,
  EnemyType,
  ProjectilePreset
} from "../domain/modPlan";

export type EngineMutation =
  | { kind: "setGravityScale"; value: number }
  | { kind: "setProjectileSpeedScale"; value: number }
  | { kind: "setPlayerMoveScale"; value: number }
  | {
      kind: "setWeaponBehavior";
      weaponType: WeaponType;
      preset: ProjectilePreset;
      fireRateScale: number;
      displayName?: string;
    }
  | { kind: "setEnemySpriteManifest"; enemyType: EnemyType; manifestHandle: string }
  | { kind: "setWeaponSpriteManifest"; weaponType: WeaponType; manifestHandle: string }
  | { kind: "setHudPatchManifest"; target: "doomguy_face"; manifestHandle: string }
  | { kind: "setEnemySoundPack"; enemyType: EnemyType; packHandle: string }
  | { kind: "setWeaponSoundPack"; weaponType: WeaponType; packHandle: string }
  | { kind: "setLevelMusic"; trackHandle: string }
  | { kind: "resetAllOverrides" };

export type EngineDiagnostics = {
  adapterName: string;
  appliedMutations: number;
  liveState: Record<string, string | number>;
};

export type QueueDiagnostics = {
  tickRate: number;
  pendingMutations: number;
  appliedMutations: number;
  lastFlushAt: number | null;
};

export type EffectivePresentation = {
  screenTint?: string;
  saturationScale?: number;
  uiThemeName?: string;
};

export type RuntimeModView = {
  id: string;
  prompt: string;
  title: string;
  summary: string;
  status: ModStatus;
  statusText: string;
  families: MutationFamily[];
  limitations: string[];
  pendingAssets: number;
  failedAssets: number;
  resolvedAssets: number;
  pendingDetails: string[];
  readyDetails: string[];
  failedDetails: string[];
  createdAt: number;
};

export type RuntimeSnapshot = {
  planningInFlight: boolean;
  mods: RuntimeModView[];
  presentation: EffectivePresentation;
  engine: EngineDiagnostics;
  queue: QueueDiagnostics;
  lastError?: string;
};

export type ResolvedAssetState = {
  status: "pending" | "ready" | "failed";
  request: NonNullable<ModPlan["assetRequests"]>[number];
  error?: string;
  handle?: string;
  progress?: string;
};

export type ActiveModState = {
  plan: ModPlan;
  status: ModStatus;
  createdAt: number;
  assets: ResolvedAssetState[];
  resolved: ResolvedAssets;
  transientErrors: string[];
};
