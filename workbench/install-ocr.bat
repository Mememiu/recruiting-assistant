@echo off
setlocal
rem ASCII-only on purpose: cmd.exe reads .bat as GBK and chokes on UTF-8 Chinese comments.
set "HERE=%~dp0"
set "VENV=%HERE%.venv-ocr"

set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys" >nul 2>nul && set "PY=python"
if not defined PY (
  echo [X] Python not found. Install Python 3.9+ from https://python.org ^(check "Add to PATH"^) and rerun.
  exit /b 1
)

if not exist "%VENV%\Scripts\python.exe" (
  echo [1/3] Creating venv at %VENV%
  %PY% -m venv "%VENV%"
  if errorlevel 1 (
    echo [X] Failed to create venv.
    exit /b 1
  )
) else (
  echo [1/3] Reusing venv at %VENV%
)

echo [2/3] Installing RapidOCR via Tsinghua mirror ^(about 100MB, first run only^)
"%VENV%\Scripts\python.exe" -m pip install --quiet --upgrade pip
"%VENV%\Scripts\python.exe" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr_onnxruntime
if errorlevel 1 (
  echo [X] pip install failed. If you are behind a proxy, unset HTTP_PROXY/HTTPS_PROXY and retry.
  exit /b 1
)

echo [3/3] Verifying import
"%VENV%\Scripts\python.exe" -c "from rapidocr_onnxruntime import RapidOCR; print('RapidOCR import OK')"
if errorlevel 1 (
  echo [X] Verification failed.
  exit /b 1
)

echo [OK] OCR ready. The workbench picks it up automatically on Windows/Linux.
exit /b 0
