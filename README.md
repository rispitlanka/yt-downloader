# Tube Grabber

Paste a YouTube **video**, **playlist** or **channel** URL, see every video in it, and download one, some, or all of them.

```
Browser ──(list videos)──▶ Vercel (Next.js, /api/resolve) ──▶ Backend (FastAPI + yt-dlp)
   │                                                            ▲
   └──────────(each video file, via signed link)────────────────┘
```

- **frontend/**: the website you host on Vercel. It never touches video files, so Vercel's time and size limits don't matter.
- **backend/**: a small Docker container with yt-dlp, ffmpeg and Deno. It does the actual downloading. Host it anywhere that runs Docker (Railway, Render, Fly.io, a VPS, or even your own PC).

The secret access key stays server-side on Vercel. The browser only gets signed download links, which expire after 24 hours.

---

## 1. Deploy the backend

### Railway (easiest)
1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → choose the repo.
3. In the service **Settings**, set **Root Directory** to `backend`. Railway picks up the Dockerfile automatically.
4. **Variables** tab, add:
   | Name | Value |
   |---|---|
   | `ACCESS_KEY` | a long random string (e.g. `openssl rand -hex 24`) |
   | `ALLOWED_ORIGINS` | your Vercel URL, e.g. `https://tube-grabber.vercel.app` (fill in after step 2; `*` works meanwhile) |
5. **Settings → Networking → Generate Domain**. Opening that URL should show `{"ok": true, ...}`.

### Render
New → **Web Service** → pick the repo → Root Directory `backend` → Runtime **Docker** → add the same variables. The free plan sleeps when idle and has little disk, so use a paid instance for whole channels.

### Your own machine / VPS
```bash
cd backend
docker build -t tube-grabber-backend .
docker run -p 8000:8000 -e ACCESS_KEY=yourkey -e ALLOWED_ORIGINS=https://your-app.vercel.app tube-grabber-backend
```
A home connection is the **most reliable** place to run the backend, because YouTube rarely blocks residential IPs. Expose it with a tunnel such as Cloudflare Tunnel so Vercel can reach it.

## 2. Deploy the front end on Vercel
1. Vercel → **Add New → Project** → import the repo.
2. Set **Root Directory** to `frontend` (framework: Next.js is detected).
3. **Environment Variables**:
   | Name | Value |
   |---|---|
   | `BACKEND_URL` | the backend URL from step 1, no trailing slash |
   | `ACCESS_KEY` | the same key as the backend |
4. Deploy, then put the Vercel URL into the backend's `ALLOWED_ORIGINS`.

## Using it
- Paste a link: `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/playlist?list=…`, `youtube.com/@handle`, `/channel/UC…`.
  A channel's home URL lists its **Videos** tab. For Shorts or live streams, paste `…/@handle/shorts` or `…/@handle/streams`.
- **Max videos** caps the list (the newest come first).
- Choose a quality and click **Download**.
  - **Chrome / Edge**: you pick a folder and videos save straight into it one by one. If a run stops, run it again and files already there are skipped.
  - **Firefox / Safari**: each video is held in memory, then saved. Fine for normal videos, but use Chrome/Edge for big channels.
- Each video shows "Server is fetching the video…" first. The backend downloads it fully, then streams it to you.

## When YouTube blocks the server
Cloud servers often get *"Sign in to confirm you're not a bot"*. Fixes, best first:

1. **Run the backend at home** (see above).
2. **Proxy**: set `YTDLP_PROXY=http://user:pass@host:port`. A residential proxy works best.
3. **Cookies**: export `cookies.txt` (Netscape format) from a logged-in browser with an extension such as "Get cookies.txt LOCALLY". Paste the whole file into `YTDLP_COOKIES`. Use a **spare Google account**, since YouTube can flag accounts used this way, and cookies expire, so expect to refresh them.

Also **redeploy the backend now and then**. Each build installs the newest yt-dlp, and YouTube changes often.

## Backend settings
| Variable | Default | Purpose |
|---|---|---|
| `ACCESS_KEY` | (none) | Required key for listing videos. **Set it**, or anyone who finds the URL can use your server. |
| `SIGNING_SECRET` | `ACCESS_KEY` | Secret for download links |
| `ALLOWED_ORIGINS` | `*` | Comma-separated sites allowed to download (your Vercel URL) |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | yt-dlp jobs running at once |
| `MAX_ITEMS` | `2000` | Most videos listed per URL |
| `LINK_TTL_SECONDS` | `86400` | How long download links stay valid |
| `YTDLP_PROXY` | (none) | Proxy for YouTube requests |
| `YTDLP_COOKIES` | (none) | Contents of a cookies.txt file |

## Local development
```bash
# terminal 1
cd backend && pip install -r requirements.txt   # also needs ffmpeg and deno on PATH
ACCESS_KEY=dev uvicorn main:app --port 8000
# terminal 2
cd frontend && npm install
BACKEND_URL=http://localhost:8000 ACCESS_KEY=dev npm run dev
```

## Limits
- Very long videos: the backend finishes downloading before sending, and some hosts cut requests after a time limit (Render ~100 min, Railway ~15 min of no response). Use 720p or run the backend yourself for very long videos.
- Each video needs temporary disk space on the backend equal to its size. It is deleted once sent.
- Downloading may break YouTube's Terms of Service. Use it for your own uploads, Creative Commons content, or videos you have permission to save.
