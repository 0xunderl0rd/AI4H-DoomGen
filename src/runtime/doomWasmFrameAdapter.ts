import type { EngineAdapter } from "./engineAdapter";
import { DoomWasmAdapter } from "./doomWasmAdapter";
import { createEmscriptenHookBridge } from "./emscriptenHookBridge";
import type { EngineDiagnostics, EngineMutation } from "./types";

type DoomModuleLike = {
  ccall: (
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: Array<string | number>
  ) => unknown;
};

type RuntimeWindow = Window & {
  Module?: DoomModuleLike;
  __doomStandaloneState?: {
    runtimeInitialized?: boolean;
    mainStarted?: boolean;
    bootError?: string | null;
  };
};

type DoomWasmFrameAdapterOptions = {
  getRuntimeWindow: () => RuntimeWindow | null;
};

export class DoomWasmFrameAdapter implements EngineAdapter {
  private liveAdapter: DoomWasmAdapter | null = null;
  private queuedMutations: EngineMutation[] = [];
  private lastError: string | null = null;
  private appliedMutations = 0;
  private connectedWindow: Window | null = null;

  constructor(private readonly options: DoomWasmFrameAdapterOptions) {}

  attachCanvas(_canvas: HTMLCanvasElement): void {
    recordFrameAdapterMessage("doom-wasm-iframe attachCanvas called");
    this.bindOrQueue();
  }

  applyMutation(mutation: EngineMutation): void {
    this.bindOrQueue();
    if (this.liveAdapter) {
      this.liveAdapter.applyMutation(mutation);
      this.appliedMutations += 1;
    } else {
      this.queuedMutations.push(mutation);
    }
  }

  resetAllOverrides(): void {
    this.bindOrQueue();
    if (this.liveAdapter) {
      this.liveAdapter.resetAllOverrides();
      this.appliedMutations += 1;
      return;
    }
    this.queuedMutations.push({ kind: "resetAllOverrides" });
  }

  getDiagnostics(): EngineDiagnostics {
    if (this.liveAdapter) {
      return {
        ...this.liveAdapter.getDiagnostics(),
        adapterName: "doom-wasm-iframe",
        appliedMutations: this.appliedMutations + this.liveAdapter.getDiagnostics().appliedMutations
      };
    }

    const runtimeWindow = this.options.getRuntimeWindow();
    const frameReady = Number(Boolean(runtimeWindow?.Module?.ccall));
    const runtimeInitialized = Number(Boolean(runtimeWindow?.__doomStandaloneState?.runtimeInitialized));
    const mainStarted = Number(Boolean(runtimeWindow?.__doomStandaloneState?.mainStarted));
    const bootError = runtimeWindow?.__doomStandaloneState?.bootError ?? this.lastError ?? "none";
    return {
      adapterName: this.lastError ? "doom-wasm-iframe-error" : "doom-wasm-iframe-loading",
      appliedMutations: this.appliedMutations,
      liveState: {
        queuedMutations: this.queuedMutations.length,
        bootError,
        mainStarted,
        frameReady,
        runtimeInitialized
      }
    };
  }

  dispose(): void {
    this.queuedMutations = [];
    this.liveAdapter = null;
    this.connectedWindow = null;
    this.lastError = "adapter disposed";
  }

  private bindOrQueue(): void {
    const runtimeWindow = this.options.getRuntimeWindow();
    if (!runtimeWindow?.Module?.ccall) {
      this.lastError = "Doom runtime bridge is not ready.";
      recordFrameAdapterMessage("doom-wasm-iframe waiting for Module.ccall");
      return;
    }

    if (!runtimeWindow.__doomStandaloneState?.runtimeInitialized) {
      this.lastError = runtimeWindow.__doomStandaloneState?.bootError
        ? `Runtime not initialized: ${runtimeWindow.__doomStandaloneState.bootError}`
        : "Doom runtime has not finished initialization.";
      recordFrameAdapterMessage("doom-wasm-iframe waiting for runtimeInitialized");
      return;
    }

    if (!runtimeWindow.__doomStandaloneState?.mainStarted) {
      this.lastError = runtimeWindow.__doomStandaloneState?.bootError
        ? `Doom main loop not started: ${runtimeWindow.__doomStandaloneState.bootError}`
        : "Doom main loop has not started yet.";
      recordFrameAdapterMessage("doom-wasm-iframe waiting for mainStarted");
      return;
    }

    this.lastError = null;

    if (this.connectedWindow !== runtimeWindow) {
      recordFrameAdapterMessage("doom-wasm-iframe rebind detected");
      this.connectedWindow = runtimeWindow;
      this.liveAdapter = new DoomWasmAdapter(createEmscriptenHookBridge(runtimeWindow.Module));
      this.flushQueuedMutations();
      return;
    }

    if (!this.liveAdapter) {
      this.liveAdapter = new DoomWasmAdapter(createEmscriptenHookBridge(runtimeWindow.Module));
      this.flushQueuedMutations();
    }
  }

  private flushQueuedMutations(): void {
    if (!this.liveAdapter) {
      return;
    }

    const queued = this.queuedMutations;
    this.queuedMutations = [];
    if (queued.length > 0) {
      recordFrameAdapterMessage(`doom-wasm-iframe flushing ${queued.length} queued mutations`);
    }
    for (const mutation of queued) {
      if (mutation.kind === "resetAllOverrides") {
        this.liveAdapter.resetAllOverrides();
      } else {
        this.liveAdapter.applyMutation(mutation);
      }
    }
    this.appliedMutations += queued.length;
  }
}

function recordFrameAdapterMessage(message: string): void {
  const windowState = window as unknown as {
    __doomModRuntimeLog?: string[];
  };
  windowState.__doomModRuntimeLog = windowState.__doomModRuntimeLog ?? [];
  const entry = `[doom-mod] ${new Date().toISOString()} ${message}`;
  windowState.__doomModRuntimeLog.push(entry);
  windowState.__doomModRuntimeLog = windowState.__doomModRuntimeLog.slice(-120);
  console.info(entry);
}
