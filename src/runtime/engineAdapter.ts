import type { EngineDiagnostics, EngineMutation } from "./types";

export interface EngineAdapter {
  attachCanvas(canvas: HTMLCanvasElement): void;
  applyMutation(mutation: EngineMutation): void;
  resetAllOverrides(): void;
  getDiagnostics(): EngineDiagnostics;
  dispose(): void;
}
