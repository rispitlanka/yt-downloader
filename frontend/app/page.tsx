"use client";

import { useRef, useState } from "react";

type Video = { id: string; title: string; duration: number | null; thumbnail: string; downloadUrl: string };
type Resolved = { kind: "video" | "playlist" | "channel"; title: string; count: number; videos: Video[] };
type Status =
  | { s: "queued" }
  | { s: "preparing" }
  | { s: "downloading"; got: number; total: number }
  | { s: "done" }
  | { s: "skipped" }
  | { s: "error"; msg: string };

const QUALITY_OPTIONS = [
  { v: "best", label: "Best quality (MP4)", ext: "mp4" },
  { v: "1080", label: "1080p (MP4)", ext: "mp4" },
  { v: "720", label: "720p (MP4)", ext: "mp4" },
  { v: "audio", label: "Audio only (M4A)", ext: "m4a" },
];

// Must match safe_name() in the backend
function safeName(title: string) {
  const n = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return n.slice(0, 120) || "video";
}

function fmtDuration(s: number | null) {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
}

function fmtBytes(b: number) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function filenameFrom(res: Response, fallback: string) {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) return decodeURIComponent(star[1].replace(/"/g, ""));
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : fallback;
}

async function errorText(res: Response) {
  try {
    const j = await res.json();
    return j.detail ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Read a response body chunk by chunk, reporting progress. */
async function pump(res: Response, onChunk: (c: Uint8Array) => Promise<void> | void, onProgress: (got: number) => void) {
  const reader = res.body!.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await onChunk(value);
    got += value.length;
    onProgress(got);
  }
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [limit, setLimit] = useState("");
  const [quality, setQuality] = useState("best");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Resolved | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const supportsFolder = typeof window !== "undefined" && "showDirectoryPicker" in window;

  async function fetchList(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setData(null);
    setStatus({});
    setLoading(true);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, limit: limit ? Number(limit) : undefined }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const d: Resolved = await res.json();
      if (!d.videos.length) throw new Error("No videos found at that URL");
      setData(d);
      setSelected(new Set(d.videos.map((v) => v.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const set = (id: string, st: Status) => setStatus((p) => ({ ...p, [id]: st }));

  async function downloadAll() {
    if (!data) return;
    const queue = data.videos.filter((v) => selected.has(v.id));
    if (!queue.length) return;
    const ext = QUALITY_OPTIONS.find((q) => q.v === quality)!.ext;

    // Chrome/Edge: write straight into a folder the user picks (no memory limits, no popups).
    let dir: FileSystemDirectoryHandle | null = null;
    if (supportsFolder) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dir = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      } catch {
        return; // user cancelled the picker
      }
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setStatus(Object.fromEntries(queue.map((v) => [v.id, { s: "queued" } as Status])));

    for (const v of queue) {
      if (ctrl.signal.aborted) break;
      const expectedName = `${safeName(v.title)} [${v.id}].${ext}`;

      if (dir) {
        try {
          const existing = await dir.getFileHandle(expectedName);
          if ((await existing.getFile()).size > 0) {
            set(v.id, { s: "skipped" });
            continue;
          }
        } catch {
          /* not there yet */
        }
      }

      set(v.id, { s: "preparing" });
      try {
        const res = await fetch(`${v.downloadUrl}&q=${quality}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(await errorText(res));
        const total = Number(res.headers.get("content-length") ?? 0);
        const name = filenameFrom(res, expectedName);
        const onProgress = (got: number) => set(v.id, { s: "downloading", got, total });

        if (dir) {
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          try {
            await pump(res, (c) => w.write(c as unknown as BufferSource), onProgress);
            await w.close();
          } catch (e) {
            await w.abort().catch(() => {});
            await dir.removeEntry(name).catch(() => {});
            throw e;
          }
        } else {
          // Other browsers: buffer in memory, then hand the file to the browser.
          const parts: Uint8Array[] = [];
          await pump(res, (c) => void parts.push(c), onProgress);
          const blobUrl = URL.createObjectURL(new Blob(parts as BlobPart[]));
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        }
        set(v.id, { s: "done" });
      } catch (err) {
        if (ctrl.signal.aborted) {
          set(v.id, { s: "error", msg: "Cancelled" });
          break;
        }
        set(v.id, { s: "error", msg: err instanceof Error ? err.message : String(err) });
      }
    }
    setRunning(false);
    abortRef.current = null;
  }

  const counts = Object.values(status).reduce(
    (acc, st) => ((acc[st.s] = (acc[st.s] ?? 0) + 1), acc),
    {} as Record<string, number>,
  );
  const allSelected = !!data && selected.size === data.videos.length;

  return (
    <main className="wrap">
      <header className="hero">
        <div className="logo" aria-hidden>
          <svg viewBox="0 0 24 24" width="28" height="28">
            <path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <h1>Tube Grabber</h1>
          <p className="sub">Paste a video, playlist or channel link. Grab one video or the whole lot.</p>
        </div>
      </header>

      <form className="card form" onSubmit={fetchList}>
        <input
          className="url"
          type="text"
          inputMode="url"
          placeholder="https://www.youtube.com/@channel  or  https://youtu.be/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          disabled={loading || running}
        />
        <div className="row">
          <label className="field">
            <span>Max videos</span>
            <input type="number" min={1} placeholder="All" value={limit} onChange={(e) => setLimit(e.target.value)} disabled={loading || running} />
          </label>
          <button className="btn primary" disabled={loading || running}>
            {loading ? <span className="spin" /> : null}
            {loading ? "Looking up…" : "Find videos"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>

      {data && (
        <section className="card">
          <div className="listhead">
            <div>
              <div className="kind">{data.kind}</div>
              <h2>{data.title || "Results"}</h2>
              <p className="muted">
                {data.count} video{data.count === 1 ? "" : "s"} · {selected.size} selected
              </p>
            </div>
            <div className="actions">
              <select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={running}>
                {QUALITY_OPTIONS.map((q) => (
                  <option key={q.v} value={q.v}>{q.label}</option>
                ))}
              </select>
              {running ? (
                <button className="btn danger" onClick={() => abortRef.current?.abort()}>Cancel</button>
              ) : (
                <button className="btn primary" onClick={downloadAll} disabled={!selected.size}>
                  Download {selected.size === 1 ? "video" : `${selected.size} videos`}
                </button>
              )}
            </div>
          </div>

          <p className="hint">
            {supportsFolder
              ? "You'll pick a folder; videos are saved into it one at a time. Re-running skips files already there."
              : "Tip: use Chrome or Edge to save straight into a folder. In this browser each video is held in memory before saving."}
          </p>

          {Object.keys(status).length > 0 && (
            <div className="summary">
              <span>{counts.done ?? 0} done</span>
              {counts.skipped ? <span>{counts.skipped} skipped</span> : null}
              {counts.error ? <span className="bad">{counts.error} failed</span> : null}
              <span>{(counts.queued ?? 0) + (counts.preparing ?? 0) + (counts.downloading ?? 0)} remaining</span>
            </div>
          )}

          {data.videos.length > 1 && (
            <label className="selectall">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={running}
                onChange={() => setSelected(allSelected ? new Set() : new Set(data.videos.map((v) => v.id)))}
              />
              Select all
            </label>
          )}

          <ul className="list">
            {data.videos.map((v) => {
              const st = status[v.id];
              return (
                <li key={v.id} className={selected.has(v.id) ? "" : "off"}>
                  <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} disabled={running} aria-label={`Select ${v.title}`} />
                  <div className="thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.thumbnail} alt="" loading="lazy" />
                    {v.duration ? <span className="dur">{fmtDuration(v.duration)}</span> : null}
                  </div>
                  <div className="meta">
                    <a href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer" className="title">{v.title}</a>
                    <StatusLine st={st} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="foot">Only download videos you own or have permission to save.</footer>
    </main>
  );
}

function StatusLine({ st }: { st?: Status }) {
  if (!st) return null;
  switch (st.s) {
    case "queued":
      return <span className="st muted">Queued</span>;
    case "preparing":
      return <span className="st"><span className="spin small" /> Server is fetching the video…</span>;
    case "downloading": {
      const pct = st.total ? Math.round((st.got / st.total) * 100) : null;
      return (
        <span className="st">
          <span className="bar"><span style={{ width: `${pct ?? 50}%` }} /></span>
          {fmtBytes(st.got)}{st.total ? ` / ${fmtBytes(st.total)}` : ""}
        </span>
      );
    }
    case "done":
      return <span className="st ok">✓ Saved</span>;
    case "skipped":
      return <span className="st muted">Already in folder</span>;
    case "error":
      return <span className="st bad" title={st.msg}>✕ {st.msg}</span>;
  }
}
