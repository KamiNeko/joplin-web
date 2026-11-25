#!/usr/bin/env python3
"""
Lightweight loopback HTTP OCR bridge for Joplin Web instant attachment OCR.

Uses a pdftotext / pdfinfo / pdftoppm / tesseract OCR pipeline,
guarded by X-Ocr-Secret and bounded to two concurrent subprocess workers.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGE_PIXELS = 3508
MAX_PDF_PAGES = int(os.environ.get("OCR_MAX_PDF_PAGES", "40"))
MAX_CONCURRENCY = max(1, int(os.environ.get("OCR_BRIDGE_CONCURRENCY", "2")))
WORK_ROOT = Path(os.environ.get("OCR_BRIDGE_WORK_DIR", "/tmp/joplin-ocr-bridge"))

os.environ["OMP_THREAD_LIMIT"] = "1"

IMAGE_MIMES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/jp2",
}
MIME_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/jp2": ".jp2",
    "application/pdf": ".pdf",
}

ALIAS_PATTERN = re.compile(r"(?<![A-Za-z0-9])(?:[A-Za-z0-9]\s+){2,}[A-Za-z0-9](?![A-Za-z0-9])")
SEMAPHORE = threading.Semaphore(MAX_CONCURRENCY)


def run_tesseract(image_path: Path) -> list[str]:
    found: list[str] = []
    for lang, psm in [("chi_tra+eng", "11")]:
        proc = subprocess.run(
            ["tesseract", str(image_path), "stdout", "-l", lang, "--psm", psm],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            found.append(proc.stdout)
    return found


def extract_ocr_text(data: bytes, mime: str, filename: str) -> str:
    clean_mime = (mime or "").split(";", 1)[0].strip().lower()
    ext = MIME_EXT.get(clean_mime)
    if not ext:
        suffix = Path(filename or "file").suffix.lower()
        ext = suffix if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else ".bin"
    WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="ocr-", dir=WORK_ROOT) as tmp:
        tmp_dir = Path(tmp)
        source = tmp_dir / f"input{ext}"
        source.write_bytes(data)

        if clean_mime == "application/pdf" or ext == ".pdf":
            pdf_text = subprocess.run(
                ["pdftotext", "-enc", "UTF-8", str(source), "-"],
                capture_output=True,
                text=True,
                timeout=60,
            ).stdout
            parts = [pdf_text]
            info = subprocess.run(["pdfinfo", str(source)], capture_output=True, text=True, timeout=60).stdout
            pages = int(m.group(1)) if (m := re.search(r"^Pages:\s+(\d+)", info, re.M)) else 0
            size = re.search(r"^Page size:\s+([\d.]+) x ([\d.]+) pts", info, re.M)
            long_side = max(float(size.group(1)), float(size.group(2))) if size else 842.0
            dpi = max(100, min(300, round(MAX_PAGE_PIXELS * 72 / long_side)))
            if pages <= 0 and not pdf_text.strip():
                raise RuntimeError("PDF has no readable pages")
            page_limit = min(pages, MAX_PDF_PAGES)
            failed_pages: list[int] = []
            for number in range(1, page_limit + 1):
                page = tmp_dir / "page.png"
                try:
                    subprocess.run(
                        [
                            "pdftoppm",
                            "-r",
                            str(dpi),
                            "-png",
                            "-singlefile",
                            "-f",
                            str(number),
                            "-l",
                            str(number),
                            str(source),
                            str(tmp_dir / "page"),
                        ],
                        check=True,
                        capture_output=True,
                        timeout=180,
                    )
                    parts.extend(run_tesseract(page))
                except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
                    failed_pages.append(number)
                page.unlink(missing_ok=True)
            if page_limit > 0 and len(failed_pages) == page_limit and not pdf_text.strip():
                raise RuntimeError(f"all {page_limit} pages failed to render or OCR")
        elif clean_mime in IMAGE_MIMES or clean_mime.startswith("image/"):
            parts = run_tesseract(source)
        else:
            raise ValueError(f"Unsupported MIME type for OCR: {clean_mime or 'unknown'}")

    text = "\n".join(p.strip() for p in parts if p and p.strip())
    aliases = sorted(
        {
            re.sub(r"\s+", "", match)
            for match in ALIAS_PATTERN.findall(text)
            if len(re.sub(r"\s+", "", match)) >= 3
        }
    )
    if aliases:
        text += "\n\nOCR compact aliases:\n" + "\n".join(aliases)
    return text[: 7 * 1024 * 1024]


class OcrHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def send_json(self, code: int, payload: dict[str, object]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(404, {"error": "Not found"})
            return
        tools = {name: bool(shutil.which(name)) for name in ("tesseract", "pdftotext", "pdfinfo", "pdftoppm")}
        ok = all(tools.values())
        self.send_json(200 if ok else 503, {"ok": ok, "tools": tools})

    def do_POST(self) -> None:
        if self.path != "/ocr":
            self.send_json(404, {"error": "Not found"})
            return

        secret = self.server.ocr_secret  # type: ignore[attr-defined]
        provided = (self.headers.get("X-Ocr-Secret") or "").strip()
        if not secret or not hmac.compare_digest(provided.encode("utf-8"), secret.encode("utf-8")):
            self.send_json(401, {"error": "Invalid OCR secret"})
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self.send_json(400, {"error": "Invalid Content-Length"})
            return
        if length <= 0:
            self.send_json(400, {"error": "Empty request body"})
            return
        if length > MAX_BYTES:
            self.send_json(413, {"error": "File exceeds 25 MB limit"})
            return

        data = self.rfile.read(length)
        mime = self.headers.get("X-File-Mime") or self.headers.get("Content-Type") or "application/octet-stream"
        filename = unquote(self.headers.get("X-File-Name") or "file")

        with SEMAPHORE:
            try:
                text = extract_ocr_text(data, mime, filename)
                self.send_json(200, {"ok": True, "text": text})
            except ValueError as exc:
                self.send_json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self.send_json(500, {"ok": False, "error": str(exc)[:300]})


def main() -> None:
    host = os.environ.get("OCR_BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("OCR_BRIDGE_PORT", "18319"))
    secret = (os.environ.get("OCR_SERVICE_SECRET") or "").strip()
    if not secret:
        raise SystemExit("OCR_SERVICE_SECRET environment variable is required")

    WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    for stale in WORK_ROOT.iterdir():
        shutil.rmtree(stale, ignore_errors=True)

    server = ThreadingHTTPServer((host, port), OcrHandler)
    server.ocr_secret = secret  # type: ignore[attr-defined]
    print(f"[joplin-ocr-bridge] listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
