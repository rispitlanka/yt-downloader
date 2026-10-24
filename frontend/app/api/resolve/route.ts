// Proxies the "list videos" call to the backend, adding the secret access key
// server-side so it never reaches the browser. Video files themselves are
// downloaded straight from the backend via signed links (Vercel functions
// can't carry multi-GB responses).

export const maxDuration = 60;

export async function POST(req: Request) {
  const backend = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!backend) {
    return Response.json({ detail: "BACKEND_URL is not set on Vercel" }, { status: 500 });
  }

  let body: { url?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ detail: "Invalid request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${backend}/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-key": process.env.ACCESS_KEY ?? "",
      },
      body: JSON.stringify({ url: body.url, limit: body.limit }),
      cache: "no-store",
    });
  } catch {
    return Response.json({ detail: "Could not reach the backend - is it running?" }, { status: 502 });
  }

  const data = await res.json().catch(() => ({ detail: `Backend error ${res.status}` }));
  if (!res.ok) return Response.json(data, { status: res.status });

  // Turn relative download paths into absolute backend URLs
  for (const v of data.videos ?? []) {
    v.downloadUrl = backend + v.downloadPath;
    delete v.downloadPath;
  }
  return Response.json(data);
}
