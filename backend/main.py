"""
YT Downloader backend.

Runs yt-dlp on a normal server (Railway, Render, a VPS...). The Vercel front end
calls /resolve through its own API route (which adds the access key), and the
browser downloads each video from /download/{id} using a short-lived signed link.
"""

import asyncio
import hashlib
import hmac
import os
import re
import shutil
import tempfile
import time
from pathlib import Path

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

# ---------------------------------------------------------------- config ----
ACCESS_KEY = os.environ.get("ACCESS_KEY", "")
SIGNING_SECRET = (os.environ.get("SIGNING_SECRET") or ACCESS_KEY or "change-me").encode()
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT_DOWNLOADS", "2"))
MAX_ITEMS = int(os.environ.get("MAX_ITEMS", "2000"))
LINK_TTL = int(os.environ.get("LINK_TTL_SECONDS", str(24 * 3600)))
PROXY = os.environ.get("YTDLP_PROXY", "")

# Optional cookies.txt contents (Netscape format) to get past YouTube's bot check.
COOKIE_FILE = None
if os.environ.get("YTDLP_COOKIES"):
    COOKIE_FILE = Path(tempfile.gettempdir()) / "yt_cookies.txt"
    cookies = os.environ["YTDLP_COOKIES"].replace("\\n", "\n").replace("\r", "").strip().strip("'\"").strip()
    # yt-dlp rejects the file unless the first line is the Netscape header
    if not re.match(r"#( Netscape)? HTTP Cookie File", cookies):
        cookies = "# Netscape HTTP Cookie File\n" + cookies
    COOKIE_FILE.write_text(cookies + "\n")

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
CHANNEL_ROOT = re.compile(
    r"^(?:https?://)?(?:www\.|m\.)?youtube\.com/"
    r"(@[^/?#]+|channel/[^/?#]+|c/[^/?#]+|user/[^/?#]+)/?(?:[?#].*)?$",
    re.I,
)

QUALITIES = {
    "best": {"format": "bv*+ba/b", "format_sort": ["res", "ext:mp4:m4a"], "ext": "mp4"},
    "1080": {"format": "bv*+ba/b", "format_sort": ["res:1080", "vcodec:h264", "acodec:m4a"], "ext": "mp4"},
    "720": {"format": "bv*+ba/b", "format_sort": ["res:720", "vcodec:h264", "acodec:m4a"], "ext": "mp4"},
    "audio": {"format": "ba[ext=m4a]/ba", "ext": "m4a"},
}

semaphore = asyncio.Semaphore(MAX_CONCURRENT)

app = FastAPI(title="YT Downloader backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "Content-Length"],
)


# --------------------------------------------------------------- helpers ----
def base_opts() -> dict:
    opts = {"quiet": True, "no_warnings": True, "noprogress": True, "retries": 5}
    if COOKIE_FILE:
        opts["cookiefile"] = str(COOKIE_FILE)
    if PROXY:
        opts["proxy"] = PROXY
    return opts


def safe_name(title: str) -> str:
    """Must match safeName() in the front end so 'skip existing' works."""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", title or "video")
    name = re.sub(r"\s+", " ", name).strip().rstrip(".")
    return name[:120] or "video"


def sign(video_id: str, exp: int) -> str:
    msg = f"{video_id}:{exp}".encode()
    return hmac.new(SIGNING_SECRET, msg, hashlib.sha256).hexdigest()[:32]


def friendly_error(err: Exception) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", str(err)).replace("ERROR: ", "")
    if "confirm you" in msg and "bot" in msg:
        return ("YouTube is blocking this server ('confirm you're not a bot'). "
                "Set YTDLP_COOKIES or YTDLP_PROXY on the backend - see the README.")
    return msg[:500]


def check_key(key: str | None) -> None:
    if ACCESS_KEY and not hmac.compare_digest(key or "", ACCESS_KEY):
        raise HTTPException(401, "Invalid access key")


# ---------------------------------------------------------------- routes ----
@app.get("/")
def health():
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__}


class ResolveRequest(BaseModel):
    url: str
    limit: int | None = None


@app.post("/resolve")
async def resolve(req: ResolveRequest, x_access_key: str | None = Header(default=None)):
    check_key(x_access_key)

    url = req.url.strip()
    if not re.match(r"^(https?://)?([\w-]+\.)*(youtube\.com|youtu\.be)/", url, re.I):
        raise HTTPException(400, "Please paste a YouTube video, playlist or channel URL")
    if not url.startswith("http"):
        url = "https://" + url
    if CHANNEL_ROOT.match(url):  # channel home page -> its Videos tab
        url = re.sub(r"[?#].*$", "", url).rstrip("/") + "/videos"

    limit = max(1, min(req.limit or MAX_ITEMS, MAX_ITEMS))
    opts = base_opts() | {"extract_flat": "in_playlist", "skip_download": True, "playlistend": limit}

    def run():
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        info = await run_in_threadpool(run)
    except Exception as e:  # yt-dlp raises many types
        raise HTTPException(502, friendly_error(e))

    if info.get("_type") in ("playlist", "multi_video"):
        entries = [e for e in (info.get("entries") or []) if e and VIDEO_ID.match(e.get("id") or "")]
        kind = "channel" if info.get("channel_id") and info.get("id") == info.get("channel_id") else "playlist"
    else:
        entries, kind = [info], "video"

    exp = int(time.time()) + LINK_TTL
    videos = [{
        "id": e["id"],
        "title": e.get("title") or e["id"],
        "duration": e.get("duration"),
        "thumbnail": f"https://i.ytimg.com/vi/{e['id']}/mqdefault.jpg",
        "downloadPath": f"/download/{e['id']}?exp={exp}&sig={sign(e['id'], exp)}",
    } for e in entries[:limit]]

    return {
        "kind": kind,
        "title": info.get("title") or info.get("channel") or "",
        "count": len(videos),
        "videos": videos,
    }


@app.get("/download/{video_id}")
async def download(
    video_id: str,
    exp: int = Query(...),
    sig: str = Query(...),
    q: str = Query("best"),
):
    if not VIDEO_ID.match(video_id):
        raise HTTPException(400, "Bad video id")
    if exp < time.time() or not hmac.compare_digest(sig, sign(video_id, exp)):
        raise HTTPException(403, "Link expired - fetch the video list again")
    if q not in QUALITIES:
        raise HTTPException(400, f"Quality must be one of {', '.join(QUALITIES)}")

    preset = QUALITIES[q]
    workdir = Path(tempfile.mkdtemp(prefix="ytdl-"))
    opts = base_opts() | {
        "format": preset["format"],
        "outtmpl": str(workdir / "%(id)s.%(ext)s"),
        "noplaylist": True,
    }
    if "format_sort" in preset:
        opts["format_sort"] = preset["format_sort"]
    if preset["ext"] == "mp4":
        opts["merge_output_format"] = "mp4"

    def run():
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)

    try:
        async with semaphore:
            info = await run_in_threadpool(run)
        files = [p for p in workdir.iterdir() if p.is_file() and not p.name.endswith((".part", ".ytdl"))]
        if not files:
            raise RuntimeError("Download produced no file")
    except Exception as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(502, friendly_error(e))

    path = max(files, key=lambda p: p.stat().st_size)
    filename = f"{safe_name(info.get('title', video_id))} [{video_id}]{path.suffix}"
    return FileResponse(
        path,
        filename=filename,
        media_type="application/octet-stream",
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )
