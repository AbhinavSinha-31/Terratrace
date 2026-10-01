"""Shared test setup: the suite must not depend on the test machine's network.

The analysis path checks that the Earth Engine host resolves before computing (app.services.analysis._ee_reachable).
Tests stub Earth Engine itself, so that DNS check is stubbed to "reachable" unless a test says otherwise.
"""

import pytest


@pytest.fixture(autouse=True)
def _earth_engine_host_resolves(monkeypatch):
    from app.services import analysis
    monkeypatch.setattr(analysis, "_ee_reachable", lambda: True)
