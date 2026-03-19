import { appEnv } from "../config/env";
import { createEmscriptenHookBridge } from "./emscriptenHookBridge";
import type { EngineAdapter } from "./engineAdapter";
import { DoomWasmAdapter } from "./doomWasmAdapter";
import type { EngineDiagnostics, EngineMutation } from "./types";

type EmscriptenFsLike = {
  createPreloadedFile: (
    parent: string,
    name: string,
    url: string,
    canRead: boolean,
    canWrite: boolean
  ) => void;
};

type EmscriptenModuleLike = {
  FS?: EmscriptenFsLike;
  ccall?: (
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: Array<string | number>
  ) => unknown;
  callMain?: (args?: string[]) => void;
  noInitialRun?: boolean;
  preRun?: () => void;
  print?: (...args: unknown[]) => void;
  printErr?: (...args: unknown[]) => void;
  canvas?: HTMLCanvasElement;
  doNotCaptureKeyboard?: boolean;
  keyboardListeningElement?: HTMLElement;
  onRuntimeInitialized?: () => void;
};

type DoomWasmState = {
  bootStarted: boolean;
  scriptLoaded: boolean;
  runtimeInitialized: boolean;
  mainStarted: boolean;
  bootError: string | null;
};

declare global {
  interface Window {
    Module?: EmscriptenModuleLike;
    callMain?: (args?: string[]) => void;
    __doomWasmState?: DoomWasmState;
  }
}

const DOOM_ARGS = ["-iwad", "doom1.wad", "-window", "-nogui", "-config", "default.cfg"];

export class DoomWasmRuntimeAdapter implements EngineAdapter {
  private bootPromise: Promise<void> | null = null;
  private liveAdapter: DoomWasmAdapter | null = null;
  private queuedMutations: EngineMutation[] = [];
  private bootError: string | null = null;
  private mainStarted = false;

  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.bootPromise) {
      return;
    }
    this.bootPromise = this.boot(canvas);
  }

  applyMutation(mutation: EngineMutation): void {
    if (this.liveAdapter) {
      this.liveAdapter.applyMutation(mutation);
      return;
    }
    this.queuedMutations.push(mutation);
  }

  resetAllOverrides(): void {
    if (this.liveAdapter) {
      this.liveAdapter.resetAllOverrides();
      return;
    }
    this.queuedMutations.push({ kind: "resetAllOverrides" });
  }

  getDiagnostics(): EngineDiagnostics {
    if (this.liveAdapter) {
      return this.liveAdapter.getDiagnostics();
    }

    return {
      adapterName: this.bootError ? "doom-wasm-error" : "doom-wasm-loading",
      appliedMutations: 0,
      liveState: {
        queuedMutations: this.queuedMutations.length,
        bootError: this.bootError ?? "none"
      }
    };
  }

  dispose(): void {
    this.liveAdapter?.dispose();
    this.liveAdapter = null;
  }

  private async boot(canvas: HTMLCanvasElement): Promise<void> {
    window.__doomWasmState = {
      bootStarted: true,
      scriptLoaded: false,
      runtimeInitialized: false,
      mainStarted: false,
      bootError: null
    };

    const module: EmscriptenModuleLike = {
      noInitialRun: true,
      canvas,
      doNotCaptureKeyboard: true,
      keyboardListeningElement: canvas,
      preRun: () => {
        if (!module.FS) {
          return;
        }
        module.FS.createPreloadedFile("", "doom1.wad", appEnv.doomWadUrl, true, true);
        module.FS.createPreloadedFile("", "default.cfg", "/doom-wasm/default.cfg", true, true);
      },
      print: (...args: unknown[]) => {
        console.log("[doom-wasm]", ...args);
      },
      printErr: (...args: unknown[]) => {
        console.error("[doom-wasm]", ...args);
      },
      onRuntimeInitialized: () => {
        if (!module.ccall) {
          this.bootError = "doom-wasm runtime initialized without ccall";
          if (window.__doomWasmState) {
            window.__doomWasmState.bootError = this.bootError;
          }
          return;
        }
        if (window.__doomWasmState) {
          window.__doomWasmState.runtimeInitialized = true;
        }
        const bridgeModule = module as EmscriptenModuleLike & {
          ccall: NonNullable<EmscriptenModuleLike["ccall"]>;
        };
        this.liveAdapter = new DoomWasmAdapter(createEmscriptenHookBridge(bridgeModule));
        this.flushQueuedMutations();
        this.startMain(module);
      }
    };

    window.Module = module;

    try {
      await loadScript(appEnv.doomWasmJsUrl);
      if (window.__doomWasmState) {
        window.__doomWasmState.scriptLoaded = true;
      }
    } catch (error) {
      this.bootError = error instanceof Error ? error.message : String(error);
      if (window.__doomWasmState) {
        window.__doomWasmState.bootError = this.bootError;
      }
    }
  }

  private flushQueuedMutations(): void {
    if (!this.liveAdapter) {
      return;
    }

    for (const mutation of this.queuedMutations) {
      if (mutation.kind === "resetAllOverrides") {
        this.liveAdapter.resetAllOverrides();
      } else {
        this.liveAdapter.applyMutation(mutation);
      }
    }
    this.queuedMutations = [];
  }

  private startMain(module: EmscriptenModuleLike): void {
    if (this.mainStarted) {
      return;
    }
    this.mainStarted = true;
    if (window.__doomWasmState) {
      window.__doomWasmState.mainStarted = true;
    }

    if (typeof module.callMain === "function") {
      module.callMain(DOOM_ARGS);
      return;
    }
    if (typeof window.callMain === "function") {
      window.callMain(DOOM_ARGS);
    }
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
        once: true
      });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
      once: true
    });
    document.head.appendChild(script);
  });
}
