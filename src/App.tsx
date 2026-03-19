import { useEffect, useRef, useState } from "preact/hooks";

import {
  appEnv,
  hasLocalGenerationConfig,
  hasOpenAiConfig
} from "./config/env";
import { LocalPlanner } from "./planning/localPlanner";
import { MockPlanner } from "./planning/mockPlanner";
import { OpenAiPlanner } from "./planning/openAiPlanner";
import { AssetGenerator } from "./runtime/assetGenerator";
import { DoomWasmFrameAdapter } from "./runtime/doomWasmFrameAdapter";
import { LocalAssetGenerator } from "./runtime/localAssetGenerator";
import { MockEngineAdapter } from "./runtime/mockEngineAdapter";
import { ModRuntimeController } from "./runtime/modRuntimeController";
import { ProviderAssetGenerator } from "./runtime/providerAssetGenerator";
import type { RuntimeSnapshot } from "./runtime/types";

const STARTER_PROMPT =
  "Make everything feel underwater, turn the pistol into a mushroom gun, and make imps weird clay monsters.";
const LOCAL_GEN_ENABLED = hasLocalGenerationConfig();
const OPENAI_GEN_ENABLED = hasOpenAiConfig();
const DOOM_WASM_ENABLED = appEnv.useDoomWasm;
const DOOM_SHELL_URL = "/doom-wasm/index.html";
const DOOM_WASM_ASSET_SUPPORT = {
  enemySpriteManifest: true,
  weaponSpriteManifest: true,
  pickupSpriteManifest: false,
  projectileFxManifest: false,
  hudPatchManifest: true,
  wallTextureManifest: false,
  flatTextureManifest: false,
  enemySoundPack: false,
  weaponSoundPack: true,
  musicTrack: false
} as const;
type LocalServiceHealth = {
  planner?: {
    available?: boolean;
    model?: string;
    status?: string;
    resident?: boolean;
    error?: string | null;
  };
  image?: {
    available?: boolean;
    backend?: string;
    model?: string;
    resident?: boolean;
    error?: string | null;
  };
  warmup?: {
    keepResident?: boolean;
  };
};

type LocalWarmupResponse = {
  ok?: boolean;
  keepResident?: boolean;
  results?: Record<string, {
    ok?: boolean;
    status?: string;
    message?: string;
    backend?: string;
    model?: string;
    elapsedSeconds?: number;
  }>;
};

type GenerationBackend = "local" | "openai";

export default function App() {
  const doomFrameRef = useRef<HTMLIFrameElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasAttachedEngineRef = useRef(false);
  const [isDoomShellLoaded, setDoomShellLoaded] = useState(!DOOM_WASM_ENABLED);
  const [generationBackend, setGenerationBackend] = useState<GenerationBackend>(() =>
    resolveInitialGenerationBackend()
  );
  const [runtime] = useState(
    () =>
      new ModRuntimeController({
        planner: createPlannerForBackend(resolveInitialGenerationBackend()),
        adapter: DOOM_WASM_ENABLED
          ? new DoomWasmFrameAdapter({
              getRuntimeWindow: () =>
                doomFrameRef.current?.contentWindow as
                  | (Window & {
                      Module?: { ccall: (id: string, returnType: string | null, argTypes: string[], args: Array<string | number>) => unknown; };
                    })
                  | null
            })
          : new MockEngineAdapter(),
        assetGenerator: createAssetGeneratorForBackend(resolveInitialGenerationBackend()),
        runtimeAssetSupport: DOOM_WASM_ENABLED
          ? DOOM_WASM_ASSET_SUPPORT
          : true
      })
  );
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => runtime.getSnapshot());
  const [isPanelOpen, setPanelOpen] = useState(true);
  const [isModsOpen, setModsOpen] = useState(true);
  const [isOverlayCollapsed, setOverlayCollapsed] = useState(false);
  const [prompt, setPrompt] = useState(STARTER_PROMPT);
  const [isSubmitting, setSubmitting] = useState(false);
  const [isEngineStarted, setEngineStarted] = useState(!DOOM_WASM_ENABLED);
  const [doomShellKey, setDoomShellKey] = useState(0);
  const [localHealth, setLocalHealth] = useState<LocalServiceHealth | null>(null);
  const [isWarmingModels, setWarmingModels] = useState(false);
  const [modelWarmMessage, setModelWarmMessage] = useState("");
  const usingLocalProviders = generationBackend === "local";

  useEffect(() => runtime.subscribe(setSnapshot), [runtime]);

  useEffect(() => {
    if (hasAttachedEngineRef.current || !isEngineStarted) {
      if (!isEngineStarted) {
        hasAttachedEngineRef.current = false;
      }
      return;
    }
    if (DOOM_WASM_ENABLED) {
      runtime.attachCanvas(document.createElement("canvas"));
      hasAttachedEngineRef.current = true;
      return;
    }
    if (canvasRef.current) {
      runtime.attachCanvas(canvasRef.current);
      hasAttachedEngineRef.current = true;
    }
  }, [runtime, isEngineStarted]);

  useEffect(() => {
    if (!isEngineStarted) {
      hasAttachedEngineRef.current = false;
    }
  }, [isEngineStarted]);

  useEffect(() => {
    const windowState = window as unknown as {
      __doomModReportRuntimeAssetFailure?: (handle: string, reason: string) => void;
      __doomModReportRuntimeAssetWarning?: (handle: string, reason: string) => void;
      __doomModReportAssetProgress?: (
        modId: string,
        kind: import("./domain/modPlan").AssetRequest["kind"],
        target: import("./domain/modPlan").AssetRequest["target"],
        message: string
      ) => void;
    };
    windowState.__doomModReportRuntimeAssetFailure = (handle, reason) => {
      runtime.reportRuntimeAssetFailure(handle, reason);
    };
    windowState.__doomModReportRuntimeAssetWarning = (handle, reason) => {
      runtime.reportRuntimeAssetWarning(handle, reason);
    };
    windowState.__doomModReportAssetProgress = (modId, kind, target, message) => {
      runtime.reportAssetProgress(modId, kind, target, message);
    };
    return () => {
      if (windowState.__doomModReportRuntimeAssetFailure) {
        delete windowState.__doomModReportRuntimeAssetFailure;
      }
      if (windowState.__doomModReportRuntimeAssetWarning) {
        delete windowState.__doomModReportRuntimeAssetWarning;
      }
      if (windowState.__doomModReportAssetProgress) {
        delete windowState.__doomModReportAssetProgress;
      }
    };
  }, [runtime]);

  useEffect(() => {
    return () => {
      runtime.dispose();
    };
  }, [runtime]);

  useEffect(() => {
    runtime.setGenerationProviders({
      planner: createPlannerForBackend(generationBackend),
      assetGenerator: createAssetGeneratorForBackend(generationBackend)
    });
  }, [runtime, generationBackend]);

  async function handleApplyPrompt(): Promise<void> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || isSubmitting) {
      return;
    }
    setSubmitting(true);
    try {
      await runtime.applyPrompt(normalizedPrompt);
      setPrompt("");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleWarmModels(): Promise<void> {
    if (!usingLocalProviders || !appEnv.localGenBaseUrl || isWarmingModels) {
      return;
    }
    setWarmingModels(true);
    setModelWarmMessage("Warming planner and image models...");
    try {
      const response = await fetch(`${trimTrailingSlash(appEnv.localGenBaseUrl)}/v1/warmup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          components: ["planner", "image"],
          keepResident: true
        })
      });
      const payload = (await response.json()) as LocalWarmupResponse;
      if (!response.ok || !payload.ok) {
        const failureMessage = summarizeWarmupFailure(payload);
        throw new Error(failureMessage || `Warmup failed (${response.status})`);
      }
      const summary = summarizeWarmupSuccess(payload);
      setModelWarmMessage(summary);
      await refreshLocalModelStatus(setLocalHealth, setModelWarmMessage, summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelWarmMessage(message);
      await refreshLocalModelStatus(setLocalHealth, setModelWarmMessage, message);
    } finally {
      setWarmingModels(false);
    }
  }

  const saturation = snapshot.presentation.saturationScale ?? 1;
  const tintStyle = {
    backgroundColor: snapshot.presentation.screenTint ?? "transparent"
  };
  const isStandaloneDoomActive = DOOM_WASM_ENABLED && isEngineStarted;
  const appRootClassName = isStandaloneDoomActive ? "app-root doom-shell-active" : "app-root";
  const appRootStyle = isStandaloneDoomActive ? undefined : { filter: `saturate(${saturation})` };
  const localModelStatusLabel = buildLocalModelStatusLabel(localHealth, modelWarmMessage);
  const generationLabel = generationBackend === "openai" ? "OpenAI" : "Local service";
  const themeLabel = snapshot.presentation.uiThemeName
    ? `Theme: ${snapshot.presentation.uiThemeName}`
    : "Theme: default";
  const dockSummary = `${generationLabel} | ${DOOM_WASM_ENABLED ? "doom-wasm shell" : "Mock runtime"} | ${snapshot.mods.length} active mod${snapshot.mods.length === 1 ? "" : "s"}`;

  const bootDoomShell = () => {
    const doomWindow = doomFrameRef.current?.contentWindow as
      | (Window & { __doomBootDoomShell?: () => boolean })
      | null
      | undefined;
    if (typeof doomWindow?.__doomBootDoomShell === "function") {
      doomWindow.__doomBootDoomShell();
    }
    runtime.attachCanvas(document.createElement("canvas"));
    runtime.refreshRuntimeState();
  };

  return (
    <div className={appRootClassName} style={appRootStyle}>
      {DOOM_WASM_ENABLED ? (
        <>
          <iframe
            ref={doomFrameRef}
            key={doomShellKey}
            src={DOOM_SHELL_URL}
            title="Doom Runtime"
            className={isEngineStarted ? "doom-shell-frame" : "doom-shell-frame doom-shell-frame-idle"}
            onLoad={() => {
              setDoomShellLoaded(true);
              runtime.attachCanvas(document.createElement("canvas"));
              runtime.refreshRuntimeState();
            }}
          />
          {!isEngineStarted ? (
            <div className="doom-shell-placeholder">
            <div className="doom-shell-placeholder-inner">
              <h2>Doom Runtime Ready</h2>
              <p>
                {isDoomShellLoaded
                  ? "Start the standalone Doom shell to verify browser boot before mod integration."
                  : "Loading Doom runtime shell..."}
              </p>
            </div>
            </div>
          ) : null}
        </>
      ) : (
        <canvas ref={canvasRef} className="doom-canvas" />
      )}
      {isStandaloneDoomActive ? null : <div className="screen-tint" style={tintStyle} />}
      {isStandaloneDoomActive ? null : <div className="ambient-grid" />}

      <div className={`overlay-dock${isOverlayCollapsed ? " is-collapsed" : ""}`}>
        <header className={`hud-bar${isOverlayCollapsed ? " is-collapsed" : ""}`}>
          <div className="hud-title">
            <h1>DoomGen MVP</h1>
            <p className="hud-summary">{isOverlayCollapsed ? dockSummary : `${themeLabel} | ${dockSummary}`}</p>
            {!isOverlayCollapsed && usingLocalProviders && localModelStatusLabel ? (
              <p className="hud-meta">{localModelStatusLabel}</p>
            ) : null}
            {!isOverlayCollapsed && generationBackend === "openai" ? (
              <p className="hud-meta">
                OpenAI image mode: {appEnv.openAiImageModel || "gpt-image-1"} @ 1024
                {` `}
                low
              </p>
            ) : null}
          </div>
          <div className="hud-actions">
            <button
              type="button"
              className="open-panel-button"
              onClick={() => {
                setOverlayCollapsed((value) => !value);
              }}
            >
              {isOverlayCollapsed ? "Expand UI" : "Minimize UI"}
            </button>
            {!isOverlayCollapsed ? (
              <div className="provider-toggle" role="group" aria-label="Generation backend">
                <button
                  type="button"
                  className={`open-panel-button provider-toggle-button${generationBackend === "local" ? " is-active" : ""}`}
                  onClick={() => {
                    setGenerationBackend("local");
                  }}
                  disabled={!LOCAL_GEN_ENABLED || isSubmitting || snapshot.planningInFlight}
                  title={LOCAL_GEN_ENABLED ? "Use local planner and local image generation." : "Local generation is not configured."}
                >
                  Local
                </button>
                <button
                  type="button"
                  className={`open-panel-button provider-toggle-button${generationBackend === "openai" ? " is-active" : ""}`}
                  onClick={() => {
                    setGenerationBackend("openai");
                  }}
                  disabled={!OPENAI_GEN_ENABLED || isSubmitting || snapshot.planningInFlight}
                  title={OPENAI_GEN_ENABLED ? "Use OpenAI planner and image generation." : "OpenAI API key is not configured."}
                >
                  OpenAI
                </button>
              </div>
            ) : null}
            {DOOM_WASM_ENABLED ? (
              <button
                type="button"
                className="open-panel-button"
                onClick={() => {
                  if (isEngineStarted) {
                    setEngineStarted(false);
                    setDoomShellLoaded(false);
                    setDoomShellKey((value) => value + 1);
                  } else {
                    setEngineStarted(true);
                    bootDoomShell();
                  }
                }}
                disabled={!isEngineStarted && !isDoomShellLoaded}
              >
                {isEngineStarted ? "Stop Doom" : isDoomShellLoaded ? "Start Doom" : "Loading Doom"}
              </button>
            ) : null}
            {!isOverlayCollapsed && usingLocalProviders ? (
              <button
                type="button"
                className="open-panel-button"
                onClick={() => {
                  void handleWarmModels();
                }}
                disabled={isWarmingModels}
                title="Preload the local planner and image models. Uses more RAM."
              >
                {isWarmingModels ? "Loading Models..." : "Load Models"}
              </button>
            ) : null}
            {!isOverlayCollapsed ? (
              <>
                <button
                  type="button"
                  className={`open-panel-button${isPanelOpen ? " is-selected" : ""}`}
                  onClick={() => {
                    setPanelOpen((open) => !open);
                  }}
                >
                  {isPanelOpen ? "Hide AI Panel" : "Show AI Panel"}
                </button>
                <button
                  type="button"
                  className={`open-panel-button${isModsOpen ? " is-selected" : ""}`}
                  onClick={() => {
                    setModsOpen((open) => !open);
                  }}
                >
                  {isModsOpen ? "Hide Mods" : "Show Mods"}
                </button>
              </>
            ) : null}
          </div>
        </header>

        {!isOverlayCollapsed && (isPanelOpen || isModsOpen) ? (
          <div className="overlay-popovers">
            {isPanelOpen ? (
              <section className="prompt-panel">
                <h2>Prompt-to-Mod</h2>
                <p>Describe mood, theme, or gameplay and DoomGen applies the safe runtime plan.</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleApplyPrompt();
                  }}
                >
                  <label htmlFor="prompt-input">Prompt</label>
                  <textarea
                    id="prompt-input"
                    value={prompt}
                    onInput={(event) => {
                      const target = event.currentTarget as HTMLTextAreaElement;
                      setPrompt(target.value);
                    }}
                    placeholder="Try: psychedelic mode with squishy clay imps and mushroom pistol."
                  />
                  <div className="prompt-actions">
                    <button
                      type="submit"
                      disabled={isSubmitting || snapshot.planningInFlight || prompt.trim().length === 0}
                    >
                      {isSubmitting || snapshot.planningInFlight ? "Applying..." : "Apply Mod"}
                    </button>
                  </div>
                </form>
              </section>
            ) : null}

            {isModsOpen ? (
              <aside className="mod-sidebar">
                <div className="mod-sidebar-header">
                  <h2>Active Mods</h2>
                  <span>{snapshot.mods.length}</span>
                </div>

                {snapshot.mods.length === 0 ? (
                  <p className="empty-state">No active mods. Open the panel and apply a prompt.</p>
                ) : (
                  <div className="mod-list">
                    {snapshot.mods.map((mod) => (
                      <article key={mod.id} className={`mod-card status-${mod.status}`}>
                        <div className="mod-card-header">
                          <h3>{mod.title}</h3>
                          <span className="status-chip">{mod.status.replaceAll("_", " ")}</span>
                        </div>
                        <p>{mod.summary}</p>
                        <p className="status-text">{mod.statusText}</p>
                        <p className="asset-stats">
                          {mod.resolvedAssets} resolved / {mod.pendingAssets} pending / {mod.failedAssets} failed
                        </p>
                        {mod.pendingDetails.length > 0 ? (
                          <p className="asset-detail asset-detail-pending">{mod.pendingDetails.join(" | ")}</p>
                        ) : null}
                        {mod.readyDetails.length > 0 ? (
                          <p className="asset-detail asset-detail-ready">{mod.readyDetails.join(" | ")}</p>
                        ) : null}
                        {mod.failedDetails.length > 0 ? (
                          <p className="asset-detail asset-detail-failed">{mod.failedDetails.join(" | ")}</p>
                        ) : null}
                        {mod.limitations.length > 0 ? (
                          <p className="limitations">{mod.limitations.join(" ")}</p>
                        ) : null}
                        <button
                          type="button"
                          className="remove-button"
                          onClick={() => {
                            runtime.removeMod(mod.id);
                          }}
                        >
                          Remove
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </aside>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="diagnostic-bar">
        <span>Adapter: {snapshot.engine.adapterName}</span>
        <span>Queue: {snapshot.queue.pendingMutations} pending</span>
        <span>Mutations: {snapshot.engine.appliedMutations}</span>
        <span>Tic: {snapshot.queue.tickRate}/sec</span>
      </footer>
    </div>
  );
}

function trimTrailingSlash(value: string): string {
  const normalized = value.trim();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function resolveInitialGenerationBackend(): GenerationBackend {
  if (appEnv.providerMode === "cloud" && OPENAI_GEN_ENABLED) {
    return "openai";
  }
  if (appEnv.providerMode === "local" && LOCAL_GEN_ENABLED) {
    return "local";
  }
  if (LOCAL_GEN_ENABLED) {
    return "local";
  }
  if (OPENAI_GEN_ENABLED) {
    return "openai";
  }
  return "local";
}

function createPlannerForBackend(backend: GenerationBackend) {
  if (backend === "openai" && OPENAI_GEN_ENABLED) {
    return new OpenAiPlanner();
  }
  if (backend === "local" && LOCAL_GEN_ENABLED) {
    return new LocalPlanner();
  }
  return new MockPlanner();
}

function createAssetGeneratorForBackend(backend: GenerationBackend) {
  if (backend === "openai" && OPENAI_GEN_ENABLED) {
    return new ProviderAssetGenerator();
  }
  if (LOCAL_GEN_ENABLED) {
    return new LocalAssetGenerator();
  }
  return new AssetGenerator();
}

async function refreshLocalModelStatus(
  setLocalHealth: (value: LocalServiceHealth | null) => void,
  setModelWarmMessage: (value: string) => void,
  nextMessage?: string
): Promise<void> {
  try {
    const response = await fetch(`${trimTrailingSlash(appEnv.localGenBaseUrl)}/v1/health`);
    if (!response.ok) {
      throw new Error(`Local service health failed (${response.status})`);
    }
    const payload = (await response.json()) as LocalServiceHealth;
    setLocalHealth(payload);
    if (!nextMessage) {
      setModelWarmMessage("");
    }
  } catch (error) {
    setLocalHealth(null);
    if (!nextMessage) {
      setModelWarmMessage(error instanceof Error ? error.message : String(error));
    }
  }
}

function buildLocalModelStatusLabel(
  health: LocalServiceHealth | null,
  warmMessage: string
): string {
  if (!health) {
    return warmMessage ? `Model warmup: ${warmMessage}` : "Model warmup: not preloaded";
  }
  const parts = [
    `planner ${describeResidentStatus(health.planner?.resident, health.planner?.status)}`,
    `image ${describeResidentStatus(health.image?.resident, health.image?.backend ? "ready" : "idle")}`,
  ];
  const keepResident = health.warmup?.keepResident ? "keep-loaded on" : "keep-loaded off";
  return warmMessage
    ? `Model warmup: ${parts.join(" / ")} (${keepResident}) - ${warmMessage}`
    : `Model warmup: ${parts.join(" / ")} (${keepResident})`;
}

function describeResidentStatus(resident: boolean | undefined, status: string | undefined): string {
  if (resident) {
    return "loaded";
  }
  if (!status) {
    return "idle";
  }
  return status.replaceAll("_", " ");
}

function summarizeWarmupFailure(payload: LocalWarmupResponse): string {
  const results = payload.results ?? {};
  const failures = Object.entries(results)
    .filter(([, result]) => !result?.ok)
    .map(([component, result]) => `${component}: ${result?.message ?? result?.status ?? "failed"}`);
  return failures.join(" | ");
}

function summarizeWarmupSuccess(payload: LocalWarmupResponse): string {
  const results = payload.results ?? {};
  const warmed = Object.entries(results)
    .filter(([, result]) => result?.ok)
    .map(([component, result]) => {
      const elapsed = typeof result?.elapsedSeconds === "number" ? ` ${result.elapsedSeconds.toFixed(1)}s` : "";
      return `${component}${elapsed}`;
    });
  return warmed.length > 0
    ? `Loaded ${warmed.join(", ")}.`
    : "Models loaded.";
}
