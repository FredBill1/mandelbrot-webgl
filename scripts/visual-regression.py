from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance


def main() -> int:
    before_dir, after_dir, output_dir = map(Path, sys.argv[1:4])
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    failed = False
    for before_path in sorted(before_dir.glob("*.png")):
        after_path = after_dir / before_path.name
        if not after_path.exists():
            raise FileNotFoundError(after_path)
        before = Image.open(before_path).convert("RGB")
        after = Image.open(after_path).convert("RGB")
        if before.size != after.size:
            raise ValueError(f"size mismatch for {before_path.name}: {before.size} != {after.size}")
        diff = ImageChops.difference(before, after)
        # The controls overlay the right edge of the canvas. UI rows may move as
        # telemetry is removed, so compare only unobscured fractal pixels.
        comparison = diff.crop((0, 0, max(1, diff.width - 480), diff.height))
        values = list(comparison.get_flattened_data())
        maxima = sorted(max(pixel) for pixel in values)
        channel_sum = sum(sum(pixel) for pixel in values)
        pixel_count = len(values)
        mean_absolute_error = channel_sum / (pixel_count * 3)
        over_16_ratio = sum(value > 16 for value in maxima) / pixel_count
        p99 = maxima[min(pixel_count - 1, int(pixel_count * 0.99))]
        passed = mean_absolute_error <= 1.5 and over_16_ratio <= 0.005
        failed |= not passed
        results.append({
            "view": before_path.stem,
            "meanAbsoluteError": round(mean_absolute_error, 4),
            "p99MaxChannelError": p99,
            "pixelsOver16Ratio": round(over_16_ratio, 6),
            "passed": passed,
        })
        ImageEnhance.Contrast(diff).enhance(4).save(output_dir / before_path.name)
    print(json.dumps(results, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
