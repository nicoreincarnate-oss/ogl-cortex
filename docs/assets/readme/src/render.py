#!/usr/bin/env python3
"""Render hero-scene.html frame by frame and encode hero.mp4, hero.gif and hero.png.

Usage:
  python3 render.py            # full render + encode into ../
  python3 render.py --stills 1.2 6.2 10.9   # write only those stills to ./stills/

Needs: Python Playwright, Google Chrome installed (channel="chrome"), ffmpeg on PATH.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
FPS = 30
SCALE = 1.5  # 1280x640 scene -> 1920x960 frames


def frames(times, dest):
    dest.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1280, "height": 640}, device_scale_factor=SCALE)
        page.goto((HERE / "hero-scene.html").as_uri())
        page.evaluate("document.fonts.ready")
        page.wait_for_function("document.fonts.status === 'loaded'")
        paths = []
        for i, t in enumerate(times):
            page.evaluate(f"seek({t})")
            p = dest / f"f{i:04d}.png"
            page.screenshot(path=str(p))
            paths.append(p)
        browser.close()
    return paths


def run(cmd):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main():
    if "--stills" in sys.argv:
        ts = [float(x) for x in sys.argv[sys.argv.index("--stills") + 1:]]
        for t, p in zip(ts, frames(ts, HERE / "stills")):
            p.rename(p.with_name(f"still-{t:05.2f}.png"))
        return

    dur = 12.0
    n = int(dur * FPS)
    tmp = Path(tempfile.mkdtemp(prefix="hero-frames-"))
    try:
        frames([i / FPS for i in range(n)], tmp)
        run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(tmp / "f%04d.png"),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow",
             "-movflags", "+faststart", str(OUT / "hero.mp4")])
        gif_filter = "fps=15,scale=960:-1:flags=lanczos"
        run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(tmp / "f%04d.png"),
             "-vf", f"{gif_filter},palettegen=max_colors=48:stats_mode=diff", str(tmp / "pal.png")])
        run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(tmp / "f%04d.png"),
             "-i", str(tmp / "pal.png"), "-lavfi",
             f"{gif_filter}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle",
             "-loop", "0", str(OUT / "hero.gif")])
        # static fallback: the report frame, every step complete
        shutil.copy(tmp / f"f{int(11.2 * FPS):04d}.png", OUT / "hero.png")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
