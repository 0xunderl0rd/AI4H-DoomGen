import { appEnv } from "../config/env";
import type { Planner } from "./planner";

type LocalPlannerOptions = {
  baseUrl?: string;
  model?: string;
};

export class LocalPlanner implements Planner {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options?: LocalPlannerOptions) {
    this.baseUrl = trimTrailingSlash(options?.baseUrl ?? appEnv.localGenBaseUrl);
    this.model = (options?.model ?? appEnv.localPlannerModel).trim();
  }

  async planPrompt(prompt: string): Promise<unknown> {
    if (!this.baseUrl) {
      throw new Error("Local planner base URL is not configured");
    }

    const response = await fetch(`${this.baseUrl}/v1/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        model: this.model
      })
    });

    if (!response.ok) {
      const details = await readResponseSummary(response);
      throw new Error(
        `Local planner failed (${response.status})${details ? `: ${details}` : ""}`
      );
    }

    const payload = (await response.json()) as {
      plan?: unknown;
      data?: unknown;
    };

    if (payload.plan !== undefined) {
      return payload.plan;
    }
    if (payload.data !== undefined) {
      return payload.data;
    }
    return payload;
  }
}

function trimTrailingSlash(value: string): string {
  const normalized = value.trim();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function readResponseSummary(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }
    return text.replace(/\s+/g, " ").slice(0, 220);
  } catch {
    return "";
  }
}
