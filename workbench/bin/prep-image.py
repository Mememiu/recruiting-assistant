#!/usr/bin/env python3
"""Prepare a resume screenshot for a vision model.

Usage: python prep-image.py <image-path> <out-jpeg-path> [max-width]

Contract:
  stdout = one JSON line: {"file": <out>, "bytes": <jpeg size>, "width": w, "height": h}
  exit 0 = success, 1 = failed to read/decode the image

Why a separate step: the workbench runs on plain Node (no image library), and
BOSS resume screenshots are very tall PNGs (713 x 4970 for a typical one).
Vision endpoints expect a modest JPEG, and a 1.1 MB PNG would turn into ~1.5 MB
of base64 — rejected by most providers and slow to upload.

Windows console defaults to GBK and will crash on Chinese output, so stdout/stderr
are reconfigured to UTF-8 explicitly.
"""
import base64
import io
import json
import os
import sys

DEFAULT_MAX_WIDTH = 640
JPEG_QUALITY = 50


def fail(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def main():
    # Must happen before any print(): GBK stdout raises on Chinese characters.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    if len(sys.argv) < 3:
        fail("用法: python prep-image.py <image-path> <out-jpeg-path> [max-width]")
    src = sys.argv[1]
    dst = sys.argv[2]
    max_width = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_MAX_WIDTH

    if not os.path.exists(src):
        fail("图片不存在: " + src)
    try:
        from PIL import Image
    except ImportError:
        fail("缺少 Pillow（install-ocr 会一并装上）", 1)

    try:
        img = Image.open(src)
        img = img.convert("RGB")
    except Exception as e:  # noqa: BLE001 - any decode failure is fatal here
        fail("图片读取失败: %s" % e, 1)

    if img.width > max_width:
        height = max(1, int(img.height * max_width / img.width))
        img = img.resize((max_width, height))

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    data = buf.getvalue()
    out_dir = os.path.dirname(os.path.abspath(dst))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(dst, "wb") as f:
        f.write(data)
    sys.stdout.write(json.dumps({
        "file": dst,
        "bytes": len(data),
        "width": img.width,
        "height": img.height,
    }, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
