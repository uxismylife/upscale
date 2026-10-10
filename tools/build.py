"""Build the standalone site page (index.html) from src/app.html.

src/app.html is written in claude.ai artifact format (no <html>/<head>/<body>); this wraps it in a full document.
Run from the repo root:  python3 tools/build.py
"""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = (root / "src" / "app.html").read_text()
cut = src.index('<div class="page">')
head, body = src[:cut].strip(), src[cut:].strip()
page = (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<meta name="description" content="Upscale any image to 4K or convert it to SVG, free and private: '
    'the AI runs in your browser and your image is never uploaded.">\n'
    + head + "\n</head>\n<body>\n" + body + "\n</body>\n</html>\n"
)
(root / "index.html").write_text(page)
print("wrote index.html", len(page), "bytes")
