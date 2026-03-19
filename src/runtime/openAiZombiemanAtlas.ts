import type { RuntimeAssetBundle } from "./providerAssetGenerator";

type OpenAiZombiemanAtlasOptions = {
  apiKey: string;
  model: string;
  brief: string;
  onPhase?: (message: string) => void;
};

type OpenAiAtlasResult = {
  assetUrl: string;
  mediaType: "image/png";
  warnings: string[];
  bundle: RuntimeAssetBundle;
};

type EnemyVisualTraits = {
  subject: string;
  fullDescription: string;
  requiredTraits: string[];
  styleOverride?: string;
};

type SheetSpec = {
  name: "sheet_a_idle_run" | "sheet_b_combat" | "sheet_c_death";
  rows: number;
  cols: number;
  prompt: string;
};

type BundleRoleSeed = {
  row: number;
  col: number;
  role: string;
  metadata: Record<string, unknown>;
};

const ENEMY_AUTHORED_ROTATIONS = ["front", "front_right", "right", "back_right", "back"] as const;

const FRAME_ID_MAP: Record<string, number> = {
  idle_a: 0,
  idle_b: 1,
  run_a: 0,
  run_b: 1,
  run_c: 2,
  run_d: 3,
  attack_a: 4,
  attack_b: 5,
  pain_a: 6,
  death_a: 7,
  death_b: 8,
  death_c: 9,
  death_d: 10,
  death_e: 11
};

export async function generateOpenAiZombiemanAtlasBundle(
  options: OpenAiZombiemanAtlasOptions
): Promise<OpenAiAtlasResult> {
  const promptTraits = parseEnemyVisualTraits(options.brief);
  const expandedDescription = expandNamedEnemyDescription(promptTraits.fullDescription);
  const keepGun = !promptExplicitlyRemovesEnemyGun(options.brief);
  const heldProp = keepGun ? "compact sidearm" : extractAlternateHeldProp(options.brief);
  const styleClause = promptTraits.styleOverride
    ? `Use a ${promptTraits.styleOverride} while keeping the sprite readable in classic Doom gameplay.`
    : "Use a gritty painted Doom aesthetic with readable shading, strong silhouette clarity, and high detail.";
  const identityDescription = buildIdentityDescription(expandedDescription, heldProp, keepGun);

  const basePrompt = [
    "Create a single full-body classic Doom enemy identity sprite on a transparent background.",
    `The character is ${identityDescription}.`,
    styleClause,
    "Front-facing, grounded on both feet, full body inside the frame, no scenery, no text, no UI, and no cropping."
  ].join(" ");

  const sheetSpecs: SheetSpec[] = [
    {
      name: "sheet_a_idle_run",
      rows: 4,
      cols: 5,
      prompt: [
        "Using the input character as the identity reference, create a transparent-background Doom enemy locomotion atlas on an invisible 5-column by 4-row grid.",
        atlasLayoutInstruction(),
        "Rows in order: row 1 idle A at front, front-right, right, back-right, back.",
        "Row 2 run A at front, front-right, right, back-right, back.",
        "Row 3 run B at front, front-right, right, back-right, back.",
        "Row 4 run C at front, front-right, right, back-right, back.",
        buildAtlasConsistencyInstruction(identityDescription, heldProp, keepGun)
      ].join(" ")
    },
    {
      name: "sheet_b_combat",
      rows: 3,
      cols: 5,
      prompt: [
        "Using the input character as the identity reference, create a transparent-background Doom enemy combat atlas on an invisible 5-column by 3-row grid.",
        atlasLayoutInstruction(),
        "Rows in order: row 1 attack A combat-ready aiming pose at front, front-right, right, back-right, back.",
        "Row 2 attack B action follow-through pose at front, front-right, right, back-right, back.",
        "Row 3 pain A impact reaction at front, front-right, right, back-right, back.",
        buildAtlasConsistencyInstruction(identityDescription, heldProp, keepGun),
        "Keep the combat poses dramatic and readable."
      ].join(" ")
    },
    {
      name: "sheet_c_death",
      rows: 1,
      cols: 5,
      prompt: [
        "Using the input character as the identity reference, create a transparent-background Doom enemy defeat atlas on an invisible 5-column by 1-row grid.",
        "Exactly one front-facing full-body defeat sprite per occupied cell.",
        "Each sprite must stay inside the middle 58 percent of its cell with very large transparent gutters on all sides.",
        "No body part, prop, clothing, debris, or collapse pose may touch or cross a cell boundary.",
        "Show five defeat frames in order from impact to collapse, ending with the character down on the ground.",
        buildAtlasConsistencyInstruction(identityDescription, heldProp, keepGun),
        "Keep the sequence dramatic and readable, but avoid graphic gore."
      ].join(" ")
    }
  ];

  const warnings: string[] = [
    "Experimental OpenAI atlas path is using a reduced zombieman bundle: idle_b reuses idle_a and run_d reuses run_c."
  ];

  options.onPhase?.("Generating zombieman base identity");
  console.info("[doom-mod] OpenAI zombieman atlas: generating base identity");
  const baseDataUrl = await requestOpenAiGeneration(options.apiKey, options.model, basePrompt);
  const baseBlob = await dataUrlToBlob(baseDataUrl);

  const sheetResults = [];
  for (const sheet of sheetSpecs) {
    options.onPhase?.(describeSheetGenerationPhase(sheet.name));
    console.info(`[doom-mod] OpenAI zombieman atlas: generating ${sheet.name}`);
    const dataUrl = await requestOpenAiEdit(options.apiKey, options.model, sheet.prompt, baseBlob);
    sheetResults.push({
      ...sheet,
      dataUrl
    });
  }

  const roleSeeds = buildRoleSeeds(keepGun);
  const roleImages = new Map<string, string>();
  const sheetDebug: Record<string, string> = {
    base_identity: baseDataUrl
  };

  for (const sheet of sheetResults) {
    options.onPhase?.(describeSheetSlicingPhase(sheet.name));
    console.info(`[doom-mod] OpenAI zombieman atlas: slicing ${sheet.name}`);
    sheetDebug[sheet.name] = sheet.dataUrl;
    const image = await loadImageElement(sheet.dataUrl);
    const tiles = sliceAtlasSheet(image, sheet.rows, sheet.cols);
    for (const seed of roleSeeds.filter((entry) => entry.metadata.sheetName === sheet.name)) {
      const tile = tiles[(seed.row - 1) * sheet.cols + (seed.col - 1)];
      roleImages.set(seed.role, canvasToDataUrl(tile));
    }
  }

  aliasRole(roleImages, "idle_b", "idle_a");
  aliasRole(roleImages, "run_d", "run_c");

  const roleEntries = roleSeeds
    .map((seed) => {
      const assetUrl = roleImages.get(seed.role) ?? "";
      return [
        seed.role,
        {
          assetUrl,
          mediaType: "image/png",
          derivedFrom: typeof seed.metadata.derivedFrom === "string" ? seed.metadata.derivedFrom : undefined,
          metadata: seed.metadata
        }
      ] as const;
    })
    .filter((entry) => entry[1].assetUrl.length > 0);

  const roles = Object.fromEntries(roleEntries);

  const primaryAssetUrl = roleImages.get("idle_a_front");
  if (!primaryAssetUrl) {
    throw new Error("OpenAI atlas generation failed to produce a base zombieman sprite");
  }

  return {
    assetUrl: primaryAssetUrl,
    mediaType: "image/png",
    warnings,
    bundle: {
      kind: "enemy_sprite_bundle",
      roles,
      metadata: {
        source: "openai_atlas",
        descriptor: identityDescription,
        keepGun,
        heldProp: heldProp ?? (keepGun ? "pistol" : undefined),
        prompts: {
          base: basePrompt,
          sheets: Object.fromEntries(sheetSpecs.map((sheet) => [sheet.name, sheet.prompt]))
        },
        sheetDebug
      }
    }
  };
}

function describeSheetGenerationPhase(
  sheetName: SheetSpec["name"]
): string {
  switch (sheetName) {
    case "sheet_a_idle_run":
      return "Generating zombieman idle and run sheet";
    case "sheet_b_combat":
      return "Generating zombieman attack and pain sheet";
    case "sheet_c_death":
      return "Generating zombieman death sheet";
  }
}

function describeSheetSlicingPhase(
  sheetName: SheetSpec["name"]
): string {
  switch (sheetName) {
    case "sheet_a_idle_run":
      return "Slicing zombieman idle and run sheet";
    case "sheet_b_combat":
      return "Slicing zombieman attack and pain sheet";
    case "sheet_c_death":
      return "Slicing zombieman death sheet";
  }
}

function atlasLayoutInstruction(): string {
  return [
    "Exactly one full-body sprite per occupied cell.",
    "Each sprite must stay inside the middle 60 percent of its cell with very large transparent gutters on all sides.",
    "No hair, arm, foot, sidearm, shadow, flash effect, clothing detail, or debris may touch or cross a cell boundary.",
    "Leave an obvious transparent gutter on every side of every occupied cell.",
    "Same scale, same foot baseline, same identity in every cell.",
    "No scenery, no text, no labels."
  ].join(" ");
}

function buildAtlasConsistencyInstruction(
  identityDescription: string,
  heldProp: string | null,
  keepGun: boolean
): string {
  const heldObjectClause = keepGun
    ? "Keep the same compact sidearm hand and sidearm silhouette across all cells."
    : heldProp
      ? `Keep the same ${heldProp} hand and ${heldProp} silhouette across all cells.`
      : "Keep the same hand posture across all cells.";
  return [
    `Keep the same character identity in every cell: ${identityDescription}.`,
    heldObjectClause
  ].join(" ");
}

function buildIdentityDescription(description: string, heldProp: string | null, keepGun: boolean): string {
  if (keepGun) {
    return `${description}, holding a compact sidearm`;
  }
  if (heldProp) {
    return `${description}, holding ${withIndefiniteArticle(heldProp)}`;
  }
  return description;
}

function withIndefiniteArticle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  const article = /^[aeiou]/i.test(trimmed) ? "an" : "a";
  return `${article} ${trimmed}`;
}

function buildRoleSeeds(keepGun: boolean): BundleRoleSeed[] {
  const seeds: BundleRoleSeed[] = [];
  const liveRows = [
    { stateRole: "idle_a", sheetName: "sheet_a_idle_run", row: 1 },
    { stateRole: "run_a", sheetName: "sheet_a_idle_run", row: 2 },
    { stateRole: "run_b", sheetName: "sheet_a_idle_run", row: 3 },
    { stateRole: "run_c", sheetName: "sheet_a_idle_run", row: 4 },
    { stateRole: "attack_a", sheetName: "sheet_b_combat", row: 1 },
    { stateRole: "attack_b", sheetName: "sheet_b_combat", row: 2 },
    { stateRole: "pain_a", sheetName: "sheet_b_combat", row: 3 }
  ];

  for (const rowSpec of liveRows) {
    ENEMY_AUTHORED_ROTATIONS.forEach((rotation, index) => {
      const role = `${rowSpec.stateRole}_${rotation}`;
      seeds.push({
        row: rowSpec.row,
        col: index + 1,
        role,
        metadata: {
          frameId: FRAME_ID_MAP[rowSpec.stateRole],
          rotation,
          stateRole: rowSpec.stateRole,
          sheetName: rowSpec.sheetName,
          derivedFrom: rowSpec.stateRole === "idle_a" && rotation === "front" ? undefined : `idle_a_${rotation}`,
          defaultWeaponPresent: keepGun
        }
      });
    });
  }

  ENEMY_AUTHORED_ROTATIONS.forEach((rotation, index) => {
    seeds.push({
      row: 1,
      col: index + 1,
      role: `idle_b_${rotation}`,
      metadata: {
        frameId: FRAME_ID_MAP.idle_b,
        rotation,
        stateRole: "idle_b",
        sheetName: "sheet_a_idle_run",
        derivedFrom: `idle_a_${rotation}`,
        defaultWeaponPresent: keepGun
      }
    });
    seeds.push({
      row: 4,
      col: index + 1,
      role: `run_d_${rotation}`,
      metadata: {
        frameId: FRAME_ID_MAP.run_d,
        rotation,
        stateRole: "run_d",
        sheetName: "sheet_a_idle_run",
        derivedFrom: `run_c_${rotation}`,
        defaultWeaponPresent: keepGun
      }
    });
  });

  ["death_a", "death_b", "death_c", "death_d", "death_e"].forEach((stateRole, index) => {
    seeds.push({
      row: 1,
      col: index + 1,
      role: `${stateRole}_front`,
      metadata: {
        frameId: FRAME_ID_MAP[stateRole],
        rotation: "front",
        stateRole,
        sheetName: "sheet_c_death",
        derivedFrom: "idle_a_front",
        defaultWeaponPresent: keepGun
      }
    });
  });

  return seeds;
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
    throw new Error("OpenAI generation returned no image data");
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
  formData.append("image[]", sourceBlob, "base_identity.png");

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
    throw new Error("OpenAI edit returned no image data");
  }
  return `data:image/png;base64,${b64}`;
}

function readOpenAiError(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: string } }).error;
    if (error?.message) {
      return `OpenAI image request failed (${status}): ${error.message}`;
    }
  }
  return `OpenAI image request failed (${status})`;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load generated image: ${src.slice(0, 96)}`));
    image.src = src;
  });
}

function sliceAtlasSheet(image: HTMLImageElement, rows: number, cols: number): HTMLCanvasElement[] {
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) {
    throw new Error("Unable to create canvas context for atlas slicing");
  }
  sourceContext.drawImage(image, 0, 0);
  const tiles: HTMLCanvasElement[] = [];
  const cellWidth = Math.floor(sourceCanvas.width / cols);
  const cellHeight = Math.floor(sourceCanvas.height / rows);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = col * cellWidth;
      const y = row * cellHeight;
      const width = col === cols - 1 ? sourceCanvas.width - x : cellWidth;
      const height = row === rows - 1 ? sourceCanvas.height - y : cellHeight;
      const cellImage = sourceContext.getImageData(x, y, width, height);
      tiles.push(isolateDominantCellComponent(cellImage));
    }
  }

  return tiles;
}

function isolateDominantCellComponent(cellImage: ImageData): HTMLCanvasElement {
  const width = cellImage.width;
  const height = cellImage.height;
  const visited = new Uint8Array(width * height);
  const alphaThreshold = 12;

  type Component = {
    area: number;
    pixels: number[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };

  const components: Component[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (visited[index]) {
        continue;
      }
      visited[index] = 1;
      const alpha = cellImage.data[index * 4 + 3];
      if (alpha <= alphaThreshold) {
        continue;
      }

      const queue = [index];
      const pixels: number[] = [];
      let pointer = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (pointer < queue.length) {
        const current = queue[pointer];
        pointer += 1;
        const cx = current % width;
        const cy = Math.floor(current / width);
        pixels.push(current);
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);
        const neighbors = [current - 1, current + 1, current - width, current + width];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= width * height || visited[neighbor]) {
            continue;
          }
          const nx = neighbor % width;
          const ny = Math.floor(neighbor / width);
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) {
            continue;
          }
          visited[neighbor] = 1;
          if (cellImage.data[neighbor * 4 + 3] > alphaThreshold) {
            queue.push(neighbor);
          }
        }
      }

      components.push({
        area: pixels.length,
        pixels,
        minX,
        minY,
        maxX,
        maxY
      });
    }
  }

  const targetX = width / 2;
  const targetY = height * 0.7;
  const chosen = components
    .sort(
      (left, right) =>
        scoreComponent(right, targetX, targetY, width, height) -
        scoreComponent(left, targetX, targetY, width, height)
    )[0];

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || !chosen) {
    return canvas;
  }

  const includedComponents = collectAttachmentComponents(components, chosen, width, height);
  const isolated = context.createImageData(width, height);
  for (const component of includedComponents) {
    for (const pixelIndex of component.pixels) {
      const dataIndex = pixelIndex * 4;
      isolated.data[dataIndex] = cellImage.data[dataIndex];
      isolated.data[dataIndex + 1] = cellImage.data[dataIndex + 1];
      isolated.data[dataIndex + 2] = cellImage.data[dataIndex + 2];
      isolated.data[dataIndex + 3] = cellImage.data[dataIndex + 3];
    }
  }

  const combinedBounds = includedComponents.reduce(
    (accumulator, component) => ({
      minX: Math.min(accumulator.minX, component.minX),
      minY: Math.min(accumulator.minY, component.minY),
      maxX: Math.max(accumulator.maxX, component.maxX),
      maxY: Math.max(accumulator.maxY, component.maxY)
    }),
    {
      minX: chosen.minX,
      minY: chosen.minY,
      maxX: chosen.maxX,
      maxY: chosen.maxY
    }
  );

  const edgePadding = {
    left: Math.max(0, 8 - combinedBounds.minX),
    top: Math.max(0, 8 - combinedBounds.minY),
    right: Math.max(0, combinedBounds.maxX - (width - 9)),
    bottom: Math.max(0, combinedBounds.maxY - (height - 9))
  };
  const edgeRisk = Math.max(edgePadding.left, edgePadding.top, edgePadding.right, edgePadding.bottom);
  const cropPadding = 10 + edgeRisk;
  const cropWidth = combinedBounds.maxX - combinedBounds.minX + 1;
  const cropHeight = combinedBounds.maxY - combinedBounds.minY + 1;
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cropWidth + cropPadding * 2;
  cropCanvas.height = cropHeight + cropPadding * 2;
  const cropContext = cropCanvas.getContext("2d");
  if (!cropContext) {
    return canvas;
  }

  const cropImage = cropContext.createImageData(cropCanvas.width, cropCanvas.height);
  for (const component of includedComponents) {
    for (const pixelIndex of component.pixels) {
      const sourceX = pixelIndex % width;
      const sourceY = Math.floor(pixelIndex / width);
      const destX = cropPadding + (sourceX - combinedBounds.minX);
      const destY = cropPadding + (sourceY - combinedBounds.minY);
      if (destX < 0 || destX >= cropCanvas.width || destY < 0 || destY >= cropCanvas.height) {
        continue;
      }
      const sourceIndex = pixelIndex * 4;
      const destIndex = (destY * cropCanvas.width + destX) * 4;
      cropImage.data[destIndex] = cellImage.data[sourceIndex];
      cropImage.data[destIndex + 1] = cellImage.data[sourceIndex + 1];
      cropImage.data[destIndex + 2] = cellImage.data[sourceIndex + 2];
      cropImage.data[destIndex + 3] = cellImage.data[sourceIndex + 3];
    }
  }
  cropContext.putImageData(cropImage, 0, 0);

  const safeMargins = edgeRisk > 0
    ? {
        side: Math.max(10, Math.round(width * 0.1)),
        top: Math.max(10, Math.round(height * 0.08)),
        bottom: Math.max(8, Math.round(height * 0.1))
      }
    : {
        side: Math.max(6, Math.round(width * 0.06)),
        top: Math.max(6, Math.round(height * 0.05)),
        bottom: Math.max(6, Math.round(height * 0.06))
      };
  const safeWidth = Math.max(1, width - safeMargins.side * 2);
  const safeHeight = Math.max(1, height - safeMargins.top - safeMargins.bottom);
  const scale = Math.min(
    safeWidth / Math.max(1, cropCanvas.width),
    safeHeight / Math.max(1, cropCanvas.height),
    edgeRisk > 0 ? 0.92 : 1
  );
  const drawWidth = Math.max(1, Math.round(cropCanvas.width * scale));
  const drawHeight = Math.max(1, Math.round(cropCanvas.height * scale));
  const pasteX = Math.max(0, Math.round((width - drawWidth) / 2));
  const pasteY = Math.max(0, height - safeMargins.bottom - drawHeight);
  context.drawImage(cropCanvas, 0, 0, cropCanvas.width, cropCanvas.height, pasteX, pasteY, drawWidth, drawHeight);
  return canvas;
}

function collectAttachmentComponents(
  components: Array<{
    area: number;
    pixels: number[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>,
  primary: {
    area: number;
    pixels: number[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  },
  width: number,
  height: number
): Array<{
  area: number;
  pixels: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}> {
  const primaryCenterX = (primary.minX + primary.maxX) / 2;
  const primaryWidth = primary.maxX - primary.minX + 1;
  const maxGap = Math.max(10, Math.round(height * 0.08));
  return components.filter((component) => {
    if (component === primary) {
      return true;
    }
    if (component.area < 24) {
      return false;
    }
    const overlapX =
      Math.min(primary.maxX, component.maxX) - Math.max(primary.minX, component.minX) + 1;
    const horizontalNear =
      overlapX >= Math.max(3, Math.round(Math.min(primaryWidth, component.maxX - component.minX + 1) * 0.2)) ||
      Math.abs(((component.minX + component.maxX) / 2) - primaryCenterX) <= Math.max(12, Math.round(width * 0.08));
    const verticalGap = Math.max(
      0,
      component.minY > primary.maxY
        ? component.minY - primary.maxY
        : primary.minY > component.maxY
          ? primary.minY - component.maxY
          : 0
    );
    return horizontalNear && verticalGap <= maxGap;
  });
}

function scoreComponent(
  component: {
    area: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  },
  targetX: number,
  targetY: number,
  width: number,
  height: number
): number {
  const centerX = (component.minX + component.maxX) / 2;
  const centerY = (component.minY + component.maxY) / 2;
  const dist = Math.hypot((centerX - targetX) / Math.max(1, width), (centerY - targetY) / Math.max(1, height));
  const borderTouch =
    (component.minX <= 1 ? 1 : 0) +
    (component.minY <= 1 ? 1 : 0) +
    (component.maxX >= width - 2 ? 1 : 0) +
    (component.maxY >= height - 2 ? 1 : 0);
  return component.area - dist * 5000 - borderTouch * 550;
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

function aliasRole(roleImages: Map<string, string>, targetStateRole: string, sourceStateRole: string): void {
  for (const rotation of ENEMY_AUTHORED_ROTATIONS) {
    const source = roleImages.get(`${sourceStateRole}_${rotation}`);
    if (source) {
      roleImages.set(`${targetStateRole}_${rotation}`, source);
    }
  }
}

function parseEnemyVisualTraits(brief: string): EnemyVisualTraits {
  const normalized = normalizeVisualTraitInput(brief);
  if (!normalized) {
    return {
      subject: "enemy",
      fullDescription: "enemy",
      requiredTraits: []
    };
  }
  const styleOverride = extractExplicitStylePhrase(normalized);
  const descriptionSource = removeStylePhrase(normalized, styleOverride);
  const fullDescription = normalizeTraitPhrase(
    extractReplacementPhrase(descriptionSource, ["zombieman", "zombie", "enemy", "monster"]) || descriptionSource,
    ["zombieman", "zombie", "enemy", "monster", "sprite", "graphic", "appearance"]
  );
  const [subject, requiredTraits] = splitSubjectAndTraits(fullDescription);
  return {
    subject: subject || "enemy",
    fullDescription: fullDescription || subject || "enemy",
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
    const subject = description.slice(0, index).trim().replace(/[-–—]+$/g, "").trim();
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

function expandNamedEnemyDescription(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("guy fieri")) {
    return "blonde spiky haired man with black glasses, a blonde goatee, a big belly, a rock and roll t shirt with red and yellow flames, bright blue jeans, and sneakers";
  }
  return value;
}

function promptExplicitlyRemovesEnemyGun(brief: string): boolean {
  const normalized = brief.toLowerCase();
  if (["no gun", "without a gun", "unarmed", "no pistol", "no firearm"].some((token) => normalized.includes(token))) {
    return true;
  }
  return [
    /\b(?:holding|carrying|wielding|playing)\s+(?:a|an|the)?\s*(guitar|microphone|sword|axe|bat|hammer|staff|wand|chainsaw)\b/i,
    /\bwith\s+(?:a|an|the)?\s*(guitar|microphone|sword|axe|bat|hammer|staff|wand|chainsaw)\b/i,
    /\binstead of\s+(?:a|an|the)?\s*(gun|pistol|firearm)\b/i
  ].some((pattern) => pattern.test(normalized));
}

function extractAlternateHeldProp(brief: string): string | null {
  const normalized = brief.toLowerCase();
  const match = normalized.match(
    /\b(?:holding|carrying|wielding|playing|with)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9\s-]{1,30})\b/i
  );
  if (!match?.[1]) {
    return null;
  }
  const candidate = match[1].trim().replace(/\s+(when|who|that|which)\b.*$/i, "").trim();
  if (!candidate || /^(gun|pistol|firearm)$/.test(candidate)) {
    return null;
  }
  return candidate;
}
