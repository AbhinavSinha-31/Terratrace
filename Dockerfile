# TERRATRACE backend (FastAPI + Earth Engine). The frontend is deployed separately (Vercel, vercel.json).
#
# Build from the repository root (the quick scan imports the research pipeline's Landsat code from analysis/):
#   docker build -t terratrace-backend .
#   docker run -p 8000:8000 -v terratrace-cache:/data --env-file backend/.env terratrace-backend
#
# One process, one worker: analysis jobs, quick scans and rate limits live in this process's memory, so the
# service must run as exactly ONE instance. Mount a persistent volume at /data (TT_CACHE_DIR).

FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    TT_CACHE_DIR=/data \
    TT_ANALYSIS_DIR=/srv/analysis

WORKDIR /srv/backend

COPY backend/requirements.txt ./requirements.txt
RUN grep -v '^pytest' requirements.txt > /tmp/requirements.txt && pip install -r /tmp/requirements.txt

# Only what the quick scan imports from the research pipeline (stdlib + earthengine-api).
COPY analysis/config.toml /srv/analysis/config.toml
COPY analysis/terratrace_analysis /srv/analysis/terratrace_analysis
COPY backend/app ./app
COPY backend/scripts ./scripts

RUN useradd --system --uid 10001 --home-dir /srv terratrace \
    && mkdir -p /data && chown terratrace /data
USER terratrace
VOLUME ["/data"]
EXPOSE 8000

# Liveness only (no Earth Engine call): /api/health also checks Earth Engine and can take several seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health/live', timeout=4)"

# --proxy-headers: rate limits count the real client (X-Forwarded-For), not the platform's proxy. Only safe when the
# container is reachable solely through that proxy (true on Railway, Render and Cloud Run); otherwise set
# TT_FORWARDED_ALLOW_IPS to the proxy's address.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"$PORT\" --workers 1 --proxy-headers --forwarded-allow-ips=\"${TT_FORWARDED_ALLOW_IPS:-*}\""]
