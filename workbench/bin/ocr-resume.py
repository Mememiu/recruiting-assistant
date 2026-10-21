#!/usr/bin/env python3
"""Resume OCR via RapidOCR (PaddleOCR's ONNX distribution).

Usage: python ocr-resume.py <image-path>

Contract (same as ocr-resume.swift):
  stdout = recognized lines, one per line, reading order
  exit 0 = success (even when no text found), 1 = failed to read/recognize,
           3 = rapidocr_onnxruntime not installed (run install-ocr first)

Windows console defaults to GBK and will crash on Chinese output, so stdout/stderr
are reconfigured to UTF-8 explicitly.
"""
import os
import re
import sys


def fail(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


# --- BOSS 平台噪声过滤 -----------------------------------------------------
# 简历页底部有「牛人分析器」统计块和平台免责声明，两者都不是简历正文：
# 统计块里的「偏好海淀区」「沟通 Boss 超过 81%」是平台算的，会被初筛误当成
# 候选人自己的意愿；免责声明则是纯法务文本。两者都要丢掉。
NOISE_LINE = re.compile(
    r"^(查看全部(\d+项分析?)?|最近关注|牛人最近7天沟通过的职位|"
    r"牛人分析器|VIP\s*专属|VIP)\s*>?$"
)
FOLD_BUTTON = re.compile(r"[.。·\s]*查看全部(\d+项分析?)?\s*>?\s*$")
LEGAL_START = "为妥善保护牛人"
LEGAL_END = re.compile(r"存储。?\s*$")
ANALYZER_START = "牛人分析器"
ANALYZER_END = re.compile(r"^查看全部\d*项分析")


def clean_lines(lines):
    """Drop platform chrome, keep resume body only."""
    out = []
    skip_legal = False
    skip_analyzer = False
    for raw in lines:
        s = raw.strip()
        if not s:
            continue
        if skip_legal:
            if LEGAL_END.search(s):
                skip_legal = False
            continue
        if LEGAL_START in s:
            skip_legal = not LEGAL_END.search(s)
            continue
        if skip_analyzer:
            if ANALYZER_END.match(s):
                skip_analyzer = False
            continue
        if ANALYZER_START in s:
            skip_analyzer = not ANALYZER_END.match(s)
            continue
        if NOISE_LINE.match(s):
            continue
        s = FOLD_BUTTON.sub("", s).strip()
        if s:
            out.append(s)
    return out


def self_test():
    """Pure-function check for the noise filter; runs without rapidocr installed."""
    cases = [
        ("分析器块", ["牛人分析器 牛人 37分钟前 沟通过boss", "查看全部8项分析 >", "工作经历", "某公司"], ["工作经历", "某公司"]),
        ("免责声明", ["为妥善保护牛人在BOSS直聘平台提交", "附件简历）中的个人信息", "存储。", "教育经历"], ["教育经历"]),
        ("折叠按钮", ["·多次担任项目负责人，具备机器人软硬件集.查看全部"], ["·多次担任项目负责人，具备机器人软硬件集"]),
        ("噪声标签", ["最近关注", "牛人最近7天沟通过的职位", "深圳丨C/C++丨6-11K"], ["深圳丨C/C++丨6-11K"]),
        ("正文保留", ["湖南城市学院", "2023-2027", "人工智能丨本科"], ["湖南城市学院", "2023-2027", "人工智能丨本科"]),
    ]
    bad = 0
    for name, src, want in cases:
        got = clean_lines(src)
        if got != want:
            bad += 1
            sys.stderr.write(f"[FAIL] {name}\n  want: {want}\n  got:  {got}\n")
        else:
            sys.stderr.write(f"[ok] {name}\n")
    sys.exit(1 if bad else 0)


def main():
    # Must happen before any print(): GBK stdout raises on Chinese characters.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return self_test()

    if len(sys.argv) != 2:
        fail("用法: ocr-resume.py <图片路径>")
    img = sys.argv[1]
    if not os.path.isfile(img):
        fail("图片不存在: " + img)

    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        fail("缺少 rapidocr_onnxruntime，请先运行 install-ocr 脚本安装 OCR 依赖", 3)

    try:
        ocr = RapidOCR()
        result, _ = ocr(img)
    except Exception as e:  # noqa: BLE001 - report any OCR backend failure as-is
        fail("简历文字识别失败: " + str(e))

    items = []
    for row in (result or []):
        # row = (box, text, score); box = [[x,y] * 4] in pixel coords, y grows downward
        if len(row) < 2:
            continue
        box, text = row[0], row[1]
        if not text or not str(text).strip():
            continue
        try:
            ys = [float(p[1]) for p in box]
            xs = [float(p[0]) for p in box]
            items.append(((sum(ys) / len(ys), sum(xs) / len(xs)), str(text).strip()))
        except (TypeError, ValueError, ZeroDivisionError):
            items.append(((0.0, 0.0), str(text).strip()))

    # Pixel y grows downward: ascending y = top to bottom. Group near-equal y rows by x.
    items.sort(key=lambda it: (round(it[0][0] / 12.0), it[0][1]))
    lines = clean_lines([text for _, text in items])
    sys.stdout.write("\n".join(lines))
    sys.exit(0)


if __name__ == "__main__":
    main()
