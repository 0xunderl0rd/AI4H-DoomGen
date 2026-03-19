#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import io

import requests
from PIL import Image, ImageDraw


API_URL = "https://api.openai.com/v1/images"
DEFAULT_MODEL = "gpt-image-1.5"
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "high"
DEFAULT_MODERATION = "low"
DEFAULT_OUTPUT_FORMAT = "png"


DESCRIPTOR = (
    "a flamboyant blonde rock-and-roll man with short spiky bleached hair, black wraparound "
    "sunglasses, a blonde goatee, a broad face, a slightly heavy belly, a black bowling-style "
    "shirt with bright red and yellow flames, bright blue jeans, dark boots, and a pistol"
)


BASE_PROMPT = (
    "Create a single full-body classic Doom enemy identity sprite on a transparent background. "
    f"The character is {DESCRIPTOR}. "
    "Front-facing, grounded on both feet, gritty painted Doom aesthetic, readable silhouette, "
    "full body inside frame, no scenery, no text, no UI, no shadow floor, no cropping."
)

SHEET_A_PROMPT = (
    "Using the input character as the identity reference, create a transparent-background Doom "
    "enemy locomotion atlas on an invisible 5-column by 4-row grid. Exactly one full-body sprite "
    "per occupied cell. Each sprite must stay inside the middle 68 percent of its cell with large "
    "transparent gutters on all sides. No body part, gun, hair, elbow, foot, or shadow may touch "
    "or cross a cell boundary. Same scale, same foot baseline, same character identity in every "
    "cell. No scenery, no text, no labels. "
    "Rows in order: row 1 idle A at front, front-right, right, back-right, back. "
    "Row 2 run A at front, front-right, right, back-right, back. "
    "Row 3 run B at front, front-right, right, back-right, back. "
    "Row 4 run C at front, front-right, right, back-right, back. "
    "Keep the same spiky blonde hair, black sunglasses, blonde goatee, flame shirt, blue jeans, "
    "boots, and pistol hand across all cells."
)

SHEET_B_PROMPT = (
    "Using the input character as the identity reference, create a transparent-background Doom "
    "enemy combat atlas on an invisible 5-column by 3-row grid. Exactly one full-body sprite per "
    "occupied cell. Each sprite must stay inside the middle 68 percent of its cell with large "
    "transparent gutters on all sides. No part of the sprite may touch or cross a cell boundary. "
    "Same scale, same foot baseline, same identity in every cell. No scenery, no text, no labels. "
    "Rows in order: row 1 attack A aiming at front, front-right, right, back-right, back. "
    "Row 2 attack B firing recoil at front, front-right, right, back-right, back. "
    "Row 3 pain A hit reaction at front, front-right, right, back-right, back. "
    "Keep the same spiky blonde hair, black sunglasses, blonde goatee, flame shirt, blue jeans, "
    "boots, and pistol hand across all cells. Preserve dramatic hit reaction and firing readability."
)

SHEET_C_PROMPT = (
    "Using the input character as the identity reference, create a transparent-background Doom "
    "enemy death atlas on an invisible 5-column by 1-row grid. Exactly one front-facing full-body "
    "sprite per occupied cell. Each sprite must stay inside the middle 70 percent of its cell with "
    "large transparent gutters on all sides. No part may touch or cross a cell boundary. Same "
    "identity, same costume, same scale. No scenery, no text, no labels. Show five death frames in "
    "order from impact to collapse, with rich gore and damage effects, ending in a corpse on the ground."
)


@dataclass
class SheetSpec:
    name: str
    rows: int
    cols: int
    prompt: str


SHEETS = (
    SheetSpec("sheet_a_idle_run", 4, 5, SHEET_A_PROMPT),
    SheetSpec("sheet_b_combat", 3, 5, SHEET_B_PROMPT),
    SheetSpec("sheet_c_death", 1, 5, SHEET_C_PROMPT),
)


def load_dotenv(workdir: Path) -> None:
    env_path = workdir / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def require_openai_api_key() -> str:
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("VITE_OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY or VITE_OPENAI_API_KEY is required")
    return api_key


def generation_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def decode_image_payload(payload: dict) -> Image.Image:
    image_data = payload.get("data", [])
    if not image_data:
        raise RuntimeError("OpenAI returned no image data")
    image_record = image_data[0]
    b64_json = image_record.get("b64_json")
    if not b64_json:
        raise RuntimeError("OpenAI image response did not include b64_json")
    data = base64.b64decode(b64_json)
    return Image.open(io.BytesIO(data)).convert("RGBA")


def generate_image(api_key: str, model: str, prompt: str) -> tuple[Image.Image, float]:
    started = time.perf_counter()
    response = requests.post(
        f"{API_URL}/generations",
        headers={
            **generation_headers(api_key),
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "prompt": prompt,
            "size": DEFAULT_SIZE,
            "quality": DEFAULT_QUALITY,
            "background": "transparent",
            "output_format": DEFAULT_OUTPUT_FORMAT,
            "n": 1,
            "moderation": DEFAULT_MODERATION,
        },
        timeout=600,
    )
    if not response.ok:
        raise RuntimeError(f"OpenAI generation failed ({response.status_code}): {response.text}")
    return decode_image_payload(response.json()), time.perf_counter() - started


def edit_image(api_key: str, model: str, prompt: str, source_path: Path) -> tuple[Image.Image, float]:
    started = time.perf_counter()
    with source_path.open("rb") as image_file:
        response = requests.post(
            f"{API_URL}/edits",
            headers=generation_headers(api_key),
            files={"image[]": (source_path.name, image_file, "image/png")},
            data={
                "model": model,
                "prompt": prompt,
                "size": DEFAULT_SIZE,
                "quality": DEFAULT_QUALITY,
                "input_fidelity": "high",
                "output_format": DEFAULT_OUTPUT_FORMAT,
                "n": "1",
            },
            timeout=600,
        )
    if not response.ok:
        raise RuntimeError(f"OpenAI edit failed ({response.status_code}): {response.text}")
    return decode_image_payload(response.json()), time.perf_counter() - started


def alpha_components(alpha: list[list[int]]) -> list[tuple[int, tuple[int, int, int, int], list[tuple[int, int]]]]:
    height = len(alpha)
    width = len(alpha[0]) if height else 0
    visited = [[False] * width for _ in range(height)]
    components: list[tuple[int, tuple[int, int, int, int], list[tuple[int, int]]]] = []
    for y in range(height):
        for x in range(width):
            if visited[y][x] or alpha[y][x] <= 12:
                continue
            queue = deque([(x, y)])
            visited[y][x] = True
            pixels: list[tuple[int, int]] = []
            min_x = max_x = x
            min_y = max_y = y
            while queue:
                px, py = queue.popleft()
                pixels.append((px, py))
                min_x = min(min_x, px)
                max_x = max(max_x, px)
                min_y = min(min_y, py)
                max_y = max(max_y, py)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx = px + dx
                    ny = py + dy
                    if 0 <= nx < width and 0 <= ny < height and not visited[ny][nx] and alpha[ny][nx] > 12:
                        visited[ny][nx] = True
                        queue.append((nx, ny))
            components.append((len(pixels), (min_x, min_y, max_x + 1, max_y + 1), pixels))
    return components


def isolate_cell_sprite(cell: Image.Image) -> Image.Image:
    rgba = cell.convert("RGBA")
    alpha_band = rgba.getchannel("A")
    alpha = list(alpha_band.getdata())
    width, height = rgba.size
    alpha_rows = [alpha[index * width : (index + 1) * width] for index in range(height)]
    components = alpha_components(alpha_rows)
    if not components:
        return rgba

    center_x = width / 2.0
    target_y = height * 0.68

    def score(component: tuple[int, tuple[int, int, int, int], list[tuple[int, int]]]) -> float:
        area, bounds, _pixels = component
        min_x, min_y, max_x, max_y = bounds
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
        border_touch = 0
        if min_x <= 1 or min_y <= 1 or max_x >= width - 1 or max_y >= height - 1:
            border_touch = 1
        dist = math.hypot((cx - center_x) / max(1.0, width), (cy - target_y) / max(1.0, height))
        return area - dist * 5000 - border_touch * 350

    best = max(components, key=score)
    _, bounds, pixels = best

    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    src = rgba.load()
    dst = out.load()
    for px, py in pixels:
        dst[px, py] = src[px, py]

    min_x, min_y, max_x, max_y = bounds
    pad = 6
    crop_box = (
        max(0, min_x - pad),
        max(0, min_y - pad),
        min(width, max_x + pad),
        min(height, max_y + pad),
    )
    cropped = out.crop(crop_box)
    final = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    paste_x = max(0, (width - cropped.width) // 2)
    paste_y = max(0, height - cropped.height - max(4, int(height * 0.06)))
    final.alpha_composite(cropped, (paste_x, paste_y))
    return final


def slice_sheet(sheet: Image.Image, spec: SheetSpec, out_dir: Path) -> Path:
    width, height = sheet.size
    cell_w = width // spec.cols
    cell_h = height // spec.rows
    tiles: list[Image.Image] = []
    for row in range(spec.rows):
        for col in range(spec.cols):
            box = (
                col * cell_w,
                row * cell_h,
                (col + 1) * cell_w if col < spec.cols - 1 else width,
                (row + 1) * cell_h if row < spec.rows - 1 else height,
            )
            cell = sheet.crop(box)
            isolated = isolate_cell_sprite(cell)
            tile_path = out_dir / f"{spec.name}_r{row + 1}_c{col + 1}.png"
            isolated.save(tile_path, format="PNG")
            tiles.append(isolated)
    return build_contact_sheet(tiles, spec.cols, out_dir / f"{spec.name}_contact.png")


def build_contact_sheet(tiles: Iterable[Image.Image], cols: int, out_path: Path) -> Path:
    tiles = list(tiles)
    if not tiles:
        raise RuntimeError("No tiles available for contact sheet")
    tile_w, tile_h = tiles[0].size
    rows = math.ceil(len(tiles) / cols)
    canvas = Image.new("RGBA", (cols * tile_w, rows * tile_h), (18, 12, 12, 255))
    draw = ImageDraw.Draw(canvas)
    for index, tile in enumerate(tiles):
        x = (index % cols) * tile_w
        y = (index // cols) * tile_h
        canvas.alpha_composite(tile, (x, y))
        draw.rectangle((x, y, x + tile_w - 1, y + tile_h - 1), outline=(255, 190, 110, 128), width=1)
    canvas.save(out_path, format="PNG")
    return out_path


def write_text(path: Path, content: str) -> None:
    path.write_text(content.strip() + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="/tmp/openai-zombieman-guy-desc-atlas-pass2")
    parser.add_argument("--model", default=os.environ.get("VITE_OPENAI_IMAGE_MODEL", DEFAULT_MODEL))
    args = parser.parse_args()

    workdir = Path(__file__).resolve().parents[1]
    load_dotenv(workdir)
    api_key = require_openai_api_key()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    summary: dict[str, object] = {
        "model": args.model,
        "size": DEFAULT_SIZE,
        "quality": DEFAULT_QUALITY,
        "descriptor": DESCRIPTOR,
    }

    base_image, base_elapsed = generate_image(api_key, args.model, BASE_PROMPT)
    base_path = out_dir / "base_identity.png"
    base_image.save(base_path, format="PNG")
    write_text(out_dir / "base_identity.prompt.txt", BASE_PROMPT)
    summary["base_identity"] = {"path": str(base_path), "elapsedSeconds": round(base_elapsed, 2)}

    for spec in SHEETS:
        image, elapsed = edit_image(api_key, args.model, spec.prompt, base_path)
        image_path = out_dir / f"{spec.name}.png"
        image.save(image_path, format="PNG")
        write_text(out_dir / f"{spec.name}.prompt.txt", spec.prompt)
        contact_path = slice_sheet(image, spec, out_dir)
        summary[spec.name] = {
            "path": str(image_path),
            "rows": spec.rows,
            "cols": spec.cols,
            "elapsedSeconds": round(elapsed, 2),
            "contactPath": str(contact_path),
        }

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
