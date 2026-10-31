#!/usr/bin/env python3
"""Contact sheets from ACTUAL browser screenshots, never generated UI images.
Requires Pillow; these reduced previews supplement the full-resolution PNGs.
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
records = json.loads((root / "docs/evidence/tt132-visual.json").read_text())["views"]
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
for mode in ("wide", "compact"):
    rows = [row for row in records if row["mode"] == mode]
    for offset in range(0, len(rows), 12):
        group = rows[offset:offset + 12]
        sheet = Image.new("RGB", (1800, 4 * 450), "#e7f2f1")
        draw = ImageDraw.Draw(sheet)
        for i, row in enumerate(group):
            x, y = (i % 3) * 600, (i // 3) * 450
            image = Image.open(root / row["path"]).convert("RGB")
            image.thumbnail((590, 410), Image.Resampling.LANCZOS)
            sheet.paste(image, (x + 5, y + 32))
            draw.text((x + 8, y + 5), f"{row['title']} · {mode} · {row['words']} words", font=font, fill="#102c34")
        path = root / f"docs/screens/tt132-{mode}-review-{offset // 12 + 1}.jpg"
        sheet.save(path, quality=90, optimize=True)
        print(path)
