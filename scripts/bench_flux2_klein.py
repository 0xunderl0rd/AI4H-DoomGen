#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path


def choose_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def choose_dtype(device: str):
    import torch

    if device == "cuda":
        return torch.bfloat16
    if device == "mps":
        return torch.float16
    return torch.float32


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark FLUX.2 klein locally.")
    parser.add_argument(
        "--model-id",
        default="black-forest-labs/FLUX.2-klein-4B",
        help="Hugging Face model ID.",
    )
    parser.add_argument(
        "--prompt",
        default="turn the pistol into a hamburger, doom style first person weapon sprite, player hand holding it, isolated subject, no background",
        help="Prompt to render.",
    )
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--steps", type=int, default=4)
    parser.add_argument("--guidance", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--out-dir",
        default="tmp/flux2-klein-bench",
        help="Directory to write outputs into.",
    )
    parser.add_argument(
        "--cpu-offload",
        action="store_true",
        help="Enable diffusers model CPU offload.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    import torch
    from diffusers import Flux2KleinPipeline

    device = choose_device()
    dtype = choose_dtype(device)
    generator_device = "cpu" if device == "mps" else device

    print(f"model={args.model_id}")
    print(f"device={device}")
    print(f"dtype={dtype}")
    print(f"size={args.width}x{args.height}")
    print(f"steps={args.steps}")
    print(f"guidance={args.guidance}")

    t0 = time.perf_counter()
    pipe = Flux2KleinPipeline.from_pretrained(
        args.model_id,
        torch_dtype=dtype,
    )
    load_seconds = time.perf_counter() - t0

    if args.cpu_offload:
        pipe.enable_model_cpu_offload()
        placement = "cpu_offload"
    else:
        pipe = pipe.to(device)
        placement = device

    t1 = time.perf_counter()
    image = pipe(
        prompt=args.prompt,
        height=args.height,
        width=args.width,
        guidance_scale=args.guidance,
        num_inference_steps=args.steps,
        generator=torch.Generator(device=generator_device).manual_seed(args.seed),
    ).images[0]
    generate_seconds = time.perf_counter() - t1

    slug = f"{args.model_id.split('/')[-1]}-{args.width}x{args.height}-{args.steps}steps-seed{args.seed}"
    image_path = out_dir / f"{slug}.png"
    meta_path = out_dir / f"{slug}.json"
    image.save(image_path)

    metadata = {
        "model_id": args.model_id,
        "device": device,
        "dtype": str(dtype),
        "placement": placement,
        "prompt": args.prompt,
        "width": args.width,
        "height": args.height,
        "steps": args.steps,
        "guidance": args.guidance,
        "seed": args.seed,
        "load_seconds": round(load_seconds, 3),
        "generate_seconds": round(generate_seconds, 3),
        "image_path": str(image_path),
    }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(json.dumps(metadata, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
