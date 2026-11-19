"""`python -m app` — production start that reads the port from $PORT (Render, Railway, Docker).

Same as: uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1 --proxy-headers --forwarded-allow-ips="*"
One worker: analysis jobs, quick scans and rate limits live in this process's memory.
"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8000")), workers=1,
                proxy_headers=True, forwarded_allow_ips=os.environ.get("TT_FORWARDED_ALLOW_IPS", "*"))
