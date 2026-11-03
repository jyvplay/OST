#!/usr/bin/env python3
"""Paired, real-engine benchmark of exhaustive signature-ink oracles.

Inputs are frozen PDFs produced by tt81-core, not fabricated engine responses.
The reference is the original per-pixel scan; the candidate is ink_bounds.py.
Every run also hashes the entire native RGB raster and compares all outputs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import statistics
import subprocess
import sys
import time


def worker(inputs, method):
    import pymupdf
    import pypdfium2
    from PIL import Image

    sys.path.insert(0, str(Path(__file__).parent / "oracles"))
    from ink_bounds import ink_bounds
    rows = []
    for path in sorted(Path(inputs).glob("*.pdf")):
        if path.name.startswith("user-unit-rot"):
            document = pymupdf.open(path)
            pix = document[0].get_pixmap()
            assert pix.n == 3
            image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples, "raw", "RGB", pix.stride, 1)
            if method == "reference":
                pts = [(x, y) for y in range(pix.height) for x in range(pix.width) if min(pix.pixel(x, y)[:3]) < 230]
                assert pts
                bounds = [min(x for x, y in pts), min(y for x, y in pts), max(x for x, y in pts), max(y for x, y in pts)]
            else:
                bounds = ink_bounds(image)
            engine = "MuPDF"
            document.close()
        elif path.name.startswith("sig"):
            document = pypdfium2.PdfDocument(path)
            document.init_forms()
            image = document[0].render(scale=1, may_draw_forms=True).to_pil().convert("RGB")
            if method == "reference":
                pts = [(x, y) for y in range(image.height) for x in range(image.width) if min(image.getpixel((x, y))) < 230]
                assert pts
                bounds = [min(x for x, y in pts), min(y for x, y in pts), max(x for x, y in pts), max(y for x, y in pts)]
            else:
                bounds = ink_bounds(image)
            engine = "PDFium"
            document.close()
        else:
            continue
        rows.append({"name": path.name, "inputSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "engine": engine, "size": list(image.size), "rgbSha256": hashlib.sha256(image.tobytes()).hexdigest(), "inclusiveInk": bounds})
    assert len(rows) == 8, "requires all four rotations from BOTH actual render engines"
    # Attack the RGB minimum, exact 229/230 boundary, blank input and inclusive
    # single-pixel bounds without substituting any renderer or storage API.
    for channel in range(3):
        for value in [0, 228, 229, 230, 231, 255]:
            color = [255] * 3
            color[channel] = value
            image = Image.new("RGB", (19, 17), "white")
            image.putpixel((8, 11), tuple(color))
            if value < 230:
                assert ink_bounds(image) == [8, 11, 8, 11]
            else:
                try:
                    ink_bounds(image)
                except AssertionError:
                    pass
                else:
                    raise AssertionError("a 230-or-higher channel was counted as ink")
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return {"method": method, "pid": os.getpid(), "mupdfPackage": pymupdf.VersionBind, "mupdfEngine": pymupdf.VersionFitz, "cpuSeconds": usage.ru_utime + usage.ru_stime, "peakRssKiB": usage.ru_maxrss, "rows": rows, "coloredBoundaryCases": 18}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", default=".cache/tt134-raster-bench")
    parser.add_argument("--output", default="docs/evidence/tt134-raster-benchmark.json")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--worker", choices=["reference", "candidate"])
    parser.add_argument("--capture-only", action="store_true")
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.inputs, args.worker)))
        return
    if args.capture_only:
        record = worker(args.inputs, "candidate")
        Path(args.output).write_text(json.dumps(record, indent=2) + "\n")
        print("Captured complete native raster hashes:", len(record["rows"]), record["mupdfPackage"])
        return
    assert 1 <= args.trials <= 9
    records = []
    canonical = None
    for trial in range(args.trials):
        for method in (["reference", "candidate"] if trial % 2 == 0 else ["candidate", "reference"]):
            start = time.perf_counter()
            completed = subprocess.run([sys.executable, __file__, "--inputs", args.inputs, "--worker", method], check=True, capture_output=True, text=True)
            record = json.loads(completed.stdout)
            record.update(trial=trial, wallSeconds=time.perf_counter() - start)
            if canonical is None:
                canonical = record["rows"]
            assert record["rows"] == canonical, "native pixel hashes, dimensions or ink bounds changed"
            records.append(record)
            print(method, trial, round(record["wallSeconds"], 5), round(record["cpuSeconds"], 5), record["peakRssKiB"], flush=True)
    summary = {}
    for method in ["reference", "candidate"]:
        own = [r for r in records if r["method"] == method]
        summary[method] = {key: statistics.median(r[key] for r in own) for key in ["wallSeconds", "cpuSeconds", "peakRssKiB"]}
    summary["wallSpeedup"] = summary["reference"]["wallSeconds"] / summary["candidate"]["wallSeconds"]
    summary["cpuSpeedup"] = summary["reference"]["cpuSeconds"] / summary["candidate"]["cpuSeconds"]
    result = {"scope": "Two native independent raster engines, eight fixed signed PDFs, all RGB pixels, exact output equality; not universal performance", "logicalCpus": os.cpu_count(), "availableCpus": len(os.sched_getaffinity(0)), "trials": args.trials, "allOutputsEqual": True, "summary": summary, "records": records}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
