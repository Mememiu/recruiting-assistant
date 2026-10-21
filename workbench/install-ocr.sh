#!/bin/sh
# OCR dependency installer for macOS/Linux (Windows: run install-ocr.bat).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv-ocr"

PY=""
if command -v python3 >/dev/null 2>&1; then PY=python3; fi
if [ -z "$PY" ]; then
  echo "[X] python3 not found. Install Python 3.9+ first."
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "[1/3] Creating venv at $VENV"
  "$PY" -m venv "$VENV"
else
  echo "[1/3] Reusing venv at $VENV"
fi

echo "[2/3] Installing RapidOCR via Tsinghua mirror (about 100MB, first run only)"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr_onnxruntime

echo "[3/3] Verifying import"
"$VENV/bin/python" -c "from rapidocr_onnxruntime import RapidOCR; print('RapidOCR import OK')"

echo "[OK] OCR ready. macOS keeps using Apple Vision (swift) when available; this venv is the fallback."
