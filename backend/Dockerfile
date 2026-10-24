FROM python:3.12-slim

# ffmpeg merges separate video+audio streams; deno solves YouTube's JS challenges
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
# --upgrade so every rebuild picks up the newest yt-dlp (YouTube changes often)
RUN pip install --no-cache-dir --upgrade -r requirements.txt
COPY main.py .

ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
