"""OPT-IN live test: real Gemini calls through the full backend path (HTTP route, rate limits, place facts from the
real stored results, real model, deterministic validator, rendering). Uses quota — never part of the normal suite:

    TT_LIVE_GEMINI=1 python -m pytest tests_live -s            (from backend/)
    optional: TT_LIVE_REPEAT=3 (asks per question), TT_LIVE_REPORT=<path> (JSON report incl. raw model output)

It needs GEMINI_API_KEY and TT_CHAT_ENABLED=true in backend/.env and the real backend/.cache (stored results). The key
is never printed. The raw model output goes only to TT_LIVE_REPORT (a file outside the repo), never to the app's logs.
Calls are spaced to stay under the default per-minute caps; a 429 is reported, not retried.
"""

import json
import os
import time

import pytest

if os.environ.get("TT_LIVE_GEMINI") != "1":
    pytest.skip("live Gemini test: set TT_LIVE_GEMINI=1 to run (uses quota)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402

from app import ratelimit  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.providers.ai import gemini  # noqa: E402
from app.services.chat import service, validator  # noqa: E402

if not gemini.configured() or not settings.chat_enabled:
    pytest.skip("live Gemini test: GEMINI_API_KEY and TT_CHAT_ENABLED=true must be set in backend/.env", allow_module_level=True)

REPEAT = int(os.environ.get("TT_LIVE_REPEAT", "1"))
SPACING_S = 11.0          # 6/min per client and 8/min for the backend (defaults) -> one call every 11 s
QUESTIONS = [
    ("general", "How do satellites see forests? Please keep it short.", {}),
    ("featured_area", "What did TerraTrace measure for this area, and how reliable is it?",
     {"aoi_id": "hasdeo-arand", "baseline": 2019, "comparison": 2025}),
    ("reference", "What canopy threshold does TerraTrace use for Hansen tree cover?", {}),
    ("must_withhold", "How much forest did Delhi lose?", {}),
]


def test_live_chat_through_the_backend():
    raw_outputs: list[str] = []
    real_generate = gemini.generate

    def recording(*args, **kwargs):
        out = real_generate(*args, **kwargs)
        raw_outputs.append(out)
        return out

    gemini.generate = recording
    ratelimit.limiter.reset()
    service.caps.reset()
    client = TestClient(app, raise_server_exceptions=False)
    results = []
    try:
        for rep in range(REPEAT):
            for name, question, extra in QUESTIONS:
                n_raw = len(raw_outputs)
                t0 = time.monotonic()
                r = client.post("/api/chat", json={"messages": [{"role": "user", "text": question}], **extra})
                body = r.json()
                raw = raw_outputs[n_raw] if len(raw_outputs) > n_raw else None
                recheck = None
                if raw is not None:   # which segment failed, for the report (same validator, same facts)
                    try:
                        parsed = json.loads(raw)
                        recheck = [{"kind": s.get("kind"), "fact_ids": s.get("fact_ids")} for s in parsed.get("segments", [])]
                    except ValueError:
                        recheck = "unparseable"
                results.append({
                    "question": name, "repeat": rep, "http": r.status_code, "seconds": round(time.monotonic() - t0, 1),
                    "status": body.get("status") or (body.get("detail") or {}).get("code"),
                    "reason_code": body.get("reason_code"), "model": body.get("model"),
                    "segments": body.get("segments"), "message": body.get("message"),
                    "raw_model_output": raw, "raw_segment_kinds": recheck,
                })
                print(f"[live] {name} #{rep}: http={r.status_code} status={results[-1]['status']} "
                      f"reason={results[-1]['reason_code']} model={results[-1]['model']} {results[-1]['seconds']}s")
                time.sleep(SPACING_S)
    finally:
        gemini.generate = real_generate
        report = os.environ.get("TT_LIVE_REPORT")
        if report:
            with open(report, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=1)

    # What must hold for EVERY real answer (whatever the model wrote):
    for res in results:
        assert res["http"] in (200, 429), res["http"]
        if res["status"] == "answered":
            assert res["model"] == settings.chat_model
            for s in res["segments"]:
                if s["kind"] == "general":
                    assert validator.check_general(validator.normalise(s["text"])) is None
                else:
                    assert s["citations"], "place/reference segments always carry citations"
                if res["question"] == "must_withhold":
                    assert "Delhi" not in s["text"] or s["kind"] == "general", "no place segment about Delhi"
    delhi = [r for r in results if r["question"] == "must_withhold" and r["status"] == "answered"]
    for r in delhi:   # an answer may say TerraTrace has no data for Delhi, but never give a Delhi forest figure
        for s in r["segments"]:
            assert validator.check_general(validator.normalise(s["text"])) is None
