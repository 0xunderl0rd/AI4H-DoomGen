import type { EngineAdapter } from "./engineAdapter";
import type { EngineDiagnostics, EngineMutation } from "./types";

type MockState = {
  gravityScale: number;
  projectileSpeedScale: number;
  playerMoveScale: number;
  pistolPreset: string;
  pistolFireRateScale: number;
  pistolDisplayName: string;
  impSpriteManifest?: string;
  pistolSpriteManifest?: string;
  impSoundPack?: string;
  pistolSoundPack?: string;
  levelMusic?: string;
};

const INITIAL_STATE: MockState = {
  gravityScale: 1,
  projectileSpeedScale: 1,
  playerMoveScale: 1,
  pistolPreset: "bullet",
  pistolFireRateScale: 1,
  pistolDisplayName: "Pistol"
};

export class MockEngineAdapter implements EngineAdapter {
  private state: MockState = { ...INITIAL_STATE };
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animationHandle: number | null = null;
  private appliedMutations = 0;

  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas && this.ctx) {
      return;
    }

    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resizeCanvas();
    window.addEventListener("resize", this.resizeCanvas);
    if (this.animationHandle === null) {
      this.animationHandle = window.requestAnimationFrame(this.renderFrame);
    }
  }

  applyMutation(mutation: EngineMutation): void {
    switch (mutation.kind) {
      case "setGravityScale":
        this.state.gravityScale = mutation.value;
        break;
      case "setProjectileSpeedScale":
        this.state.projectileSpeedScale = mutation.value;
        break;
      case "setPlayerMoveScale":
        this.state.playerMoveScale = mutation.value;
        break;
      case "setWeaponBehavior":
        this.state.pistolPreset = mutation.preset;
        this.state.pistolFireRateScale = mutation.fireRateScale;
        if (mutation.displayName) {
          this.state.pistolDisplayName = mutation.displayName;
        }
        break;
      case "setEnemySpriteManifest":
        this.state.impSpriteManifest = mutation.manifestHandle;
        break;
      case "setWeaponSpriteManifest":
        this.state.pistolSpriteManifest = mutation.manifestHandle;
        break;
      case "setEnemySoundPack":
        this.state.impSoundPack = mutation.packHandle;
        break;
      case "setWeaponSoundPack":
        this.state.pistolSoundPack = mutation.packHandle;
        break;
      case "setLevelMusic":
        this.state.levelMusic = mutation.trackHandle;
        break;
      case "resetAllOverrides":
        this.state = { ...INITIAL_STATE };
        break;
    }
    this.appliedMutations += 1;
  }

  resetAllOverrides(): void {
    this.state = { ...INITIAL_STATE };
  }

  getDiagnostics(): EngineDiagnostics {
    return {
      adapterName: "mock-engine",
      appliedMutations: this.appliedMutations,
      liveState: {
        gravityScale: this.state.gravityScale.toFixed(2),
        playerMoveScale: this.state.playerMoveScale.toFixed(2),
        projectileSpeedScale: this.state.projectileSpeedScale.toFixed(2),
        pistolPreset: this.state.pistolPreset,
        pistolFireRateScale: this.state.pistolFireRateScale.toFixed(2),
        pistolDisplayName: this.state.pistolDisplayName,
        impSpriteManifest: this.state.impSpriteManifest ?? "-",
        pistolSpriteManifest: this.state.pistolSpriteManifest ?? "-",
        impSoundPack: this.state.impSoundPack ?? "-",
        pistolSoundPack: this.state.pistolSoundPack ?? "-",
        levelMusic: this.state.levelMusic ?? "-"
      }
    };
  }

  dispose(): void {
    window.removeEventListener("resize", this.resizeCanvas);
    if (this.animationHandle !== null) {
      window.cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
    this.canvas = null;
    this.ctx = null;
  }

  private readonly resizeCanvas = (): void => {
    if (!this.canvas) {
      return;
    }

    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.floor(this.canvas.clientWidth * ratio);
    const height = Math.floor(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  };

  private readonly renderFrame = (time: number): void => {
    if (!this.canvas || !this.ctx) {
      this.animationHandle = window.requestAnimationFrame(this.renderFrame);
      return;
    }

    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.0015 * this.state.playerMoveScale);

    ctx.clearRect(0, 0, width, height);

    const sky = ctx.createLinearGradient(0, 0, 0, height * 0.5);
    sky.addColorStop(0, `rgba(${Math.round(38 + pulse * 30)}, 68, 80, 1)`);
    sky.addColorStop(1, "rgba(8, 16, 22, 1)");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height * 0.55);

    const floor = ctx.createLinearGradient(0, height * 0.55, 0, height);
    floor.addColorStop(0, "rgba(40, 22, 12, 1)");
    floor.addColorStop(1, "rgba(10, 8, 7, 1)");
    ctx.fillStyle = floor;
    ctx.fillRect(0, height * 0.55, width, height);

    const horizonY = height * 0.55;
    for (let i = 1; i <= 16; i += 1) {
      const y = horizonY + ((height - horizonY) * i) / 16;
      const alpha = 0.03 + i * 0.005;
      ctx.strokeStyle = `rgba(255, 130, 60, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const bobStrength = 18 * this.state.playerMoveScale;
    const bobOffset = Math.sin(time * 0.005) * bobStrength;
    const weaponBaseX = width / 2;
    const weaponBaseY = height - 90 + bobOffset;

    ctx.fillStyle = "rgba(255, 180, 80, 0.8)";
    ctx.beginPath();
    ctx.moveTo(weaponBaseX - 70, weaponBaseY);
    ctx.lineTo(weaponBaseX + 70, weaponBaseY);
    ctx.lineTo(weaponBaseX + 36, weaponBaseY - 120);
    ctx.lineTo(weaponBaseX - 36, weaponBaseY - 120);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(24, 16, 10, 0.86)";
    ctx.fillRect(weaponBaseX - 22, weaponBaseY - 96, 44, 68);

    ctx.font = "700 24px 'Avenir Next', 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(245, 235, 220, 0.88)";
    ctx.fillText("DoomGen Mock Runtime", 24, 42);
    ctx.font = "500 16px 'Avenir Next', 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(255, 191, 128, 0.86)";
    ctx.fillText(
      `gravity ${this.state.gravityScale.toFixed(2)} | move ${this.state.playerMoveScale.toFixed(
        2
      )} | projectile ${this.state.projectileSpeedScale.toFixed(2)}`,
      24,
      70
    );
    ctx.fillText(
      `${this.state.pistolDisplayName} (${this.state.pistolPreset}) rate ${this.state.pistolFireRateScale.toFixed(
        2
      )}`,
      24,
      94
    );
    ctx.fillStyle = "rgba(210, 220, 230, 0.78)";
    ctx.fillText(
      `imp sprite ${shortHandle(this.state.impSpriteManifest)} | imp audio ${shortHandle(
        this.state.impSoundPack
      )}`,
      24,
      118
    );
    ctx.fillText(
      `pistol sprite ${shortHandle(this.state.pistolSpriteManifest)} | pistol audio ${shortHandle(
        this.state.pistolSoundPack
      )}`,
      24,
      142
    );
    ctx.fillText(`music ${shortHandle(this.state.levelMusic)}`, 24, 166);

    this.animationHandle = window.requestAnimationFrame(this.renderFrame);
  };
}

function shortHandle(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  return value.length <= 14 ? value : `${value.slice(0, 14)}...`;
}
