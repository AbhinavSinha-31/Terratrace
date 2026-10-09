# Pre-deployment checklist

Items that **must be resolved before the site goes public**. Each is a known gap, recorded rather than fixed so far.
Tick an item only when it is fixed and verified, and record how.

| # | Item | Why it matters | Status |
|---|---|---|---|
| 1 | **Tile routes have no per-user rate limit.** `/api/tiles/{aid}/{kind}/{year}/…`, `/api/imagery/tiles/{aid}/{year}/…` and `/api/tiles/{aid}/context/{layer}/…` are protected only by input validation, the disk tile cache, single-flight fetching and the backend-wide Earth Engine concurrency cap (`TT_EE_TILE_CONCURRENCY`, bounded queue) — not by `app/ratelimit.py`. | One client can request many uncached tiles (all zoom levels, every year and layer), occupying the shared Earth Engine slots and quota for every other user, and growing the tile cache. Cheap for cached tiles, expensive for uncached ones. | Open (recorded 2026-10-10) |
| 2 | **One integrity-suite run timed out on first load** (`page.waitForFunction: Timeout 45000ms exceeded` waiting for the map and the four featured markers). It happened right after a backend restart, while the backend was measuring the featured sites' area context for the first time (Earth Engine Restricted Mode); it could not be reproduced afterwards (the app booted in 4.6 s) and the rerun passed. | A first visit right after a deploy or restart may hang or show the offline preview until the backend's first Earth Engine work finishes. Root cause not established — possibly the cold `/api/health` waiting on Earth Engine initialisation (measured 7.3 s against the frontend's 8 s timeout) combined with startup Earth Engine work. | Open (recorded 2026-10-10) |

See also the deployment notes in the [README](../README.md#deploy).
