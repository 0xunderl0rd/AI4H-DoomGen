import type { RuntimeAssetBundle } from "./providerAssetGenerator";

type OpenAiHudFaceBundleOptions = {
  apiKey: string;
  model: string;
  brief: string;
  onPhase?: (message: string) => void;
};

type OpenAiHudFaceBundleResult = {
  assetUrl: string;
  mediaType: "image/png";
  warnings: string[];
  bundle: RuntimeAssetBundle;
};

type VisualPromptTraits = {
  subject: string;
  fullDescription: string;
  requiredTraits: string[];
  styleOverride?: string;
};

const HUD_FACE_ROLE_SPECS = {
  neutral: { width: 24, height: 29 },
  look_left: { width: 26, height: 30 },
  look_right: { width: 26, height: 30 },
  pain: { width: 24, height: 31 },
  evil_grin: { width: 24, height: 30 },
  dead: { width: 24, height: 31 }
} as const;

const HUD_FACE_ROLES = [
  "neutral",
  "look_left",
  "look_right",
  "pain",
  "evil_grin",
  "dead"
] as const;

type HudFaceRole = (typeof HUD_FACE_ROLES)[number];

export async function generateOpenAiHudFaceBundle(
  options: OpenAiHudFaceBundleOptions
): Promise<OpenAiHudFaceBundleResult> {
  const promptTraits = parseVisualTraits(options.brief);
  const styleInstruction = promptTraits.styleOverride
    ? `Follow the ${promptTraits.styleOverride} while keeping the face readable in classic Doom HUD scale.`
    : "Use gritty painted Doom-authentic shading, readable silhouette, bold eyes and mouth shapes, and transparent background.";
  const identityPrompt = [
    `Create a single classic Doom status-face portrait of ${promptTraits.fullDescription}.`,
    promptTraits.requiredTraits.length > 0
      ? `Required visible traits: ${promptTraits.requiredTraits.join(", ")}.`
      : `Primary subject: ${promptTraits.subject}.`,
    styleInstruction,
    "Face only, cropped tightly to the head, front-facing, transparent background, no shoulders, no UI, no scenery, no text."
  ].join(" ");

  const sheetPrompt = [
    `Using the input face portrait as the identity reference, create a transparent classic Doom HUD face sheet of ${promptTraits.fullDescription}.`,
    "Arrange the output on an invisible 3-column by 2-row grid with one face per cell and large transparent gutters between cells.",
    "Top row in order: neutral, look left, look right.",
    "Bottom row in order: pain grimace, evil grin, dead lifeless face.",
    "Each face must stay fully inside its own cell, with no overlap into neighboring cells.",
    "Keep the same character identity, same proportions, same palette family, same framing, and same lighting in every cell.",
    styleInstruction,
    "Face only, transparent background, no shoulders, no UI, no scenery, no text."
  ].join(" ");

  options.onPhase?.("Generating Doomguy face identity");
  const baseDataUrl = await requestOpenAiGeneration(options.apiKey, options.model, identityPrompt);
  const baseBlob = await dataUrlToBlob(baseDataUrl);

  options.onPhase?.("Generating Doomguy face sheet");
  const sheetDataUrl = await requestOpenAiEdit(options.apiKey, options.model, sheetPrompt, baseBlob);

  options.onPhase?.("Slicing Doomguy face sheet");
  const sheetImage = await loadImageElement(sheetDataUrl);
  const tiles = sliceGrid(sheetImage, 2, 3);
  const roleOrder: HudFaceRole[] = ["neutral", "look_left", "look_right", "pain", "evil_grin", "dead"];
  const slotMap = buildHudFaceSlotMap();

  const roles = Object.fromEntries(
    roleOrder.map((role, index) => {
      const normalized = normalizeHudFaceCanvas(tiles[index], role);
      return [
        role,
        {
          assetUrl: canvasToDataUrl(normalized),
          mediaType: "image/png",
          metadata: {
            canonicalExpression: role,
            mappedSlots: slotMap[role],
            size: HUD_FACE_ROLE_SPECS[role]
          }
        }
      ];
    })
  );

  return {
    assetUrl: roles.neutral.assetUrl,
    mediaType: "image/png",
    warnings: [],
    bundle: {
      kind: "hud_patch_bundle",
      roles,
      metadata: {
        source: "openai_hud_sheet",
        promptTraits,
        prompts: {
          identity: identityPrompt,
          sheet: sheetPrompt
        },
        sheetDebug: {
          identity: baseDataUrl,
          sheet: sheetDataUrl
        }
      }
    }
  };
}

function buildHudFaceSlotMap(): Record<HudFaceRole, number[]> {
  const neutral: number[] = [];
  const lookLeft: number[] = [];
  const lookRight: number[] = [];
  const pain: number[] = [];
  const evil: number[] = [];

  for (let painIndex = 0; painIndex < 5; painIndex += 1) {
    const base = painIndex * 8;
    neutral.push(base + 0, base + 1, base + 2);
    lookRight.push(base + 3);
    lookLeft.push(base + 4);
    pain.push(base + 5, base + 7);
    evil.push(base + 6);
  }
  neutral.push(40);

  return {
    neutral,
    look_left: lookLeft,
    look_right: lookRight,
    pain,
    evil_grin: evil,
    dead: [41]
  };
}

function normalizeHudFaceCanvas(sourceCanvas: HTMLCanvasElement, role: HudFaceRole): HTMLCanvasElement {
  const spec = HUD_FACE_ROLE_SPECS[role];
  const targetCanvas = document.createElement("canvas");
  targetCanvas.width = spec.width;
  targetCanvas.height = spec.height;
  const context = targetCanvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create HUD patch canvas context");
  }

  const bounds = findNonTransparentBounds(sourceCanvas);
  if (!bounds) {
    context.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
    return targetCanvas;
  }

  const placement = fitBoundsIntoBox(
    bounds.width,
    bounds.height,
    spec.width,
    spec.height,
    1,
    1,
    0
  );
  context.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  context.drawImage(
    sourceCanvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    placement.baseX,
    placement.baseY,
    placement.drawWidth,
    placement.drawHeight
  );
  return targetCanvas;
}

function fitBoundsIntoBox(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
  sideMargin: number,
  topMargin: number,
  bottomMargin: number
): { drawWidth: number; drawHeight: number; baseX: number; baseY: number } {
  const availableWidth = Math.max(1, boxWidth - sideMargin * 2);
  const availableHeight = Math.max(1, boxHeight - topMargin - bottomMargin);
  const scale = Math.min(availableWidth / Math.max(1, sourceWidth), availableHeight / Math.max(1, sourceHeight));
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  return {
    drawWidth,
    drawHeight,
    baseX: Math.max(0, Math.floor((boxWidth - drawWidth) / 2)),
    baseY: Math.max(0, Math.floor((boxHeight - bottomMargin) - drawHeight))
  };
}

function findNonTransparentBounds(
  canvas: HTMLCanvasElement
): { x: number; y: number; width: number; height: number } | null {
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  const { width, height } = canvas;
  const data = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha === 0) {
        continue;
      }
      if (x < minX) {
        minX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y > maxY) {
        maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function sliceGrid(image: HTMLImageElement, rows: number, cols: number): HTMLCanvasElement[] {
  const tileWidth = image.width / cols;
  const tileHeight = image.height / rows;
  const tiles: HTMLCanvasElement[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(tileWidth);
      canvas.height = Math.round(tileHeight);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Failed to create HUD tile canvas context");
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image,
        Math.round(col * tileWidth),
        Math.round(row * tileHeight),
        Math.round(tileWidth),
        Math.round(tileHeight),
        0,
        0,
        canvas.width,
        canvas.height
      );
      tiles.push(canvas);
    }
  }

  return tiles;
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load generated HUD face image"));
    image.src = src;
  });
}

async function requestOpenAiGeneration(apiKey: string, model: string, prompt: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt,
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
      n: 1,
      moderation: "low"
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(readOpenAiError(response.status, payload));
  }
  const b64 = payload?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("OpenAI generation returned no HUD face image");
  }
  return `data:image/png;base64,${b64}`;
}

async function requestOpenAiEdit(apiKey: string, model: string, prompt: string, sourceBlob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append("model", model);
  formData.append("prompt", prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "high");
  formData.append("background", "transparent");
  formData.append("input_fidelity", "high");
  formData.append("output_format", "png");
  formData.append("n", "1");
  formData.append("image[]", sourceBlob, "hud_face_identity.png");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(readOpenAiError(response.status, payload));
  }
  const b64 = payload?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("OpenAI edit returned no HUD face sheet");
  }
  return `data:image/png;base64,${b64}`;
}

function readOpenAiError(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: string } }).error;
    if (error?.message) {
      return `OpenAI HUD image request failed (${status}): ${error.message}`;
    }
  }
  return `OpenAI HUD image request failed (${status})`;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return await response.blob();
}

function parseVisualTraits(brief: string): VisualPromptTraits {
  const normalized = normalizeVisualTraitInput(brief);
  if (!normalized) {
    return {
      subject: "doomguy face",
      fullDescription: "doomguy face",
      requiredTraits: []
    };
  }

  const styleOverride = extractExplicitStylePhrase(normalized);
  const descriptionSource = removeStylePhrase(normalized, styleOverride);
  const fullDescription = normalizeTraitPhrase(
    extractReplacementPhrase(descriptionSource, ["doomguy", "doom guy", "status face", "hud face", "face"]) || descriptionSource,
    ["doomguy", "doom", "doom guy", "status face", "hud face", "face", "portrait", "patch"]
  );
  const [subject, requiredTraits] = splitSubjectAndTraits(fullDescription);
  return {
    subject: subject || "doomguy face",
    fullDescription: fullDescription || subject || "doomguy face",
    requiredTraits,
    styleOverride: styleOverride ?? undefined
  };
}

function normalizeVisualTraitInput(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractExplicitStylePhrase(brief: string): string | null {
  const stylePatterns = [
    /\bin\s+([a-z0-9][a-z0-9\s-]{2,40}\s+style)\b/i,
    /\b([a-z0-9][a-z0-9\s-]{2,40}\s+style)\b/i,
    /\b(watercolor|anime|comic|photoreal|photorealistic|realistic|clay|lego|pixel art|cartoon)\b/i
  ];
  for (const pattern of stylePatterns) {
    const match = brief.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function removeStylePhrase(brief: string, stylePhrase: string | null): string {
  if (!stylePhrase) {
    return brief;
  }
  const escaped = stylePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return brief
    .replace(new RegExp(`\\bin\\s+${escaped}\\b`, "ig"), "")
    .replace(new RegExp(`\\b${escaped}\\b`, "ig"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReplacementPhrase(brief: string, targets: string[]): string {
  const targetPattern = targets.join("|");
  const patterns = [
    new RegExp(
      String.raw`(?:turn|transform|swap).{0,48}(?:${targetPattern}).{0,20}into\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})`,
      "i"
    ),
    new RegExp(
      String.raw`replace.{0,48}(?:${targetPattern}).{0,20}with\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})`,
      "i"
    ),
    /(?:as)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})/i,
    /(?:into)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{2,120})/i
  ];
  for (const pattern of patterns) {
    const match = brief.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return brief.trim();
}

function normalizeTraitPhrase(value: string, removals: string[]): string {
  let candidate = value.trim().toLowerCase();
  candidate = candidate.replace(/\b(it|them|this|that)\b/g, " ");
  for (const token of removals) {
    candidate = candidate.replace(new RegExp(`\\b${token}\\b`, "g"), " ");
  }
  return candidate.replace(/\s+/g, " ").trim().replace(/^[,.;:!? -]+|[,.;:!? -]+$/g, "");
}

function splitSubjectAndTraits(description: string): [string, string[]] {
  if (!description) {
    return ["", []];
  }

  const separators = [" wearing ", " with ", " holding ", " carrying ", " topped with ", " made of ", " made from "];
  for (const separator of separators) {
    if (!description.includes(separator)) {
      continue;
    }
    const index = description.indexOf(separator);
    const subject = description.slice(0, index).trim().replace(/[-]+$/g, "").trim();
    const rawRest = description.slice(index + separator.length);
    const traits = splitTraitSegments(rawRest, separator.trim());
    return [subject || description, traits];
  }
  return [description, []];
}

function splitTraitSegments(value: string, prefix: string): string[] {
  const cleaned = value.trim().replace(/^[,.;:!? -]+|[,.;:!? -]+$/g, "");
  if (!cleaned) {
    return [];
  }
  if (prefix === "with") {
    return cleaned
      .split(/\s+and\s+|\s+with\s+|,\s*/g)
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => `with ${segment}`);
  }
  return [`${prefix} ${cleaned}`];
}
