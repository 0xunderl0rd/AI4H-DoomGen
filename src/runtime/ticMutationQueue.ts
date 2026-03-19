import type { EngineAdapter } from "./engineAdapter";
import type { EngineMutation, QueueDiagnostics } from "./types";

const DEFAULT_TICK_RATE = 35;

export class TicMutationQueue {
  private intervalHandle: number | undefined;
  private pendingMutations: EngineMutation[] = [];
  private appliedMutations = 0;
  private lastFlushAt: number | null = null;
  private readonly tickRate: number;
  private readonly onFlush?: () => void;

  constructor(
    private readonly adapter: EngineAdapter,
    tickRate = DEFAULT_TICK_RATE,
    onFlush?: () => void
  ) {
    this.tickRate = tickRate > 0 ? tickRate : DEFAULT_TICK_RATE;
    this.onFlush = onFlush;
  }

  start(): void {
    if (this.intervalHandle !== undefined) {
      return;
    }

    const intervalMs = Math.max(1, Math.round(1000 / this.tickRate));
    this.intervalHandle = window.setInterval(() => {
      this.flush();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle === undefined) {
      return;
    }
    window.clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  enqueue(mutation: EngineMutation): void {
    this.pendingMutations.push(mutation);
  }

  enqueueMany(mutations: EngineMutation[]): void {
    if (mutations.length === 0) {
      return;
    }
    this.pendingMutations.push(...mutations);
  }

  replacePending(mutations: EngineMutation[]): void {
    this.pendingMutations = [...mutations];
  }

  flush(): void {
    if (this.pendingMutations.length === 0) {
      return;
    }

    const toApply = this.pendingMutations;
    this.pendingMutations = [];
    for (const mutation of toApply) {
      if (mutation.kind === "resetAllOverrides") {
        this.adapter.resetAllOverrides();
      } else {
        this.adapter.applyMutation(mutation);
      }
    }

    this.appliedMutations += toApply.length;
    this.lastFlushAt = Date.now();
    this.onFlush?.();
  }

  getDiagnostics(): QueueDiagnostics {
    return {
      tickRate: this.tickRate,
      pendingMutations: this.pendingMutations.length,
      appliedMutations: this.appliedMutations,
      lastFlushAt: this.lastFlushAt
    };
  }
}
