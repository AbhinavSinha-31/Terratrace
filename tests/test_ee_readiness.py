"""Earth Engine readiness: health must reflect a real initialisation, not a credential file.

Uses a fake `ee` module — no credentials or network needed.
"""

import dataclasses

import pytest

from app.providers.earth_engine import provider as p


class FakeEE:
    def __init__(self, init_error: Exception | None = None, answer: int = 2):
        self.init_error, self.answer, self.init_calls, self.project = init_error, answer, 0, None
        fake = self

        class Data:   # ee.data: records the per-request deadline set at initialisation
            deadline_ms = None

            @staticmethod
            def setDeadline(ms):
                fake.data.deadline_ms = ms
        self.data = Data()

    def Initialize(self, credentials=None, project=None):
        self.init_calls += 1
        if self.init_error:
            raise self.init_error
        self.project = project

    def Number(self, n):
        answer = self.answer

        class N:
            def add(_, m):
                class V:
                    def getInfo(_):
                        return answer
                return V()
        return N()


@pytest.fixture
def prov(monkeypatch):
    monkeypatch.setattr(p, "settings", dataclasses.replace(p.settings, ee_project="proj-test", ee_service_account_key=None))
    monkeypatch.setattr(p.EarthEngineProvider, "credentials_configured", staticmethod(lambda: True))
    return p.EarthEngineProvider()


def test_unconfigured_without_credentials(monkeypatch):
    monkeypatch.setattr(p.EarthEngineProvider, "credentials_configured", staticmethod(lambda: False))
    status, detail = p.EarthEngineProvider().status()
    assert status == "unconfigured" and "EE_PROJECT" in detail and "earthengine authenticate" in detail


def test_ready_only_after_real_initialisation_and_request(prov, monkeypatch):
    fake = FakeEE()
    monkeypatch.setattr(p, "_ee", lambda: fake)
    status, detail = prov.status()
    assert status == "ready" and fake.init_calls == 1 and fake.project == "proj-test"
    assert fake.data.deadline_ms == int(p.settings.ee_request_deadline_s * 1000), "every Earth Engine request is bounded"
    assert "user credentials" in detail and "proj-test" in detail
    prov.status()
    assert fake.init_calls == 1, "a successful initialisation is reused"


def test_initialisation_failure_reports_actual_reason_redacted(prov, monkeypatch):
    fake = FakeEE(init_error=Exception("Project 'proj-test' is not registered to use Earth Engine. token ya29.SECRET"))
    monkeypatch.setattr(p, "_ee", lambda: fake)
    status, detail = prov.status()
    assert status == "error" and "not registered to use Earth Engine" in detail
    assert "SECRET" not in detail and "[redacted]" in detail


def test_failed_request_after_initialise_is_not_ready(prov, monkeypatch):
    monkeypatch.setattr(p, "_ee", lambda: FakeEE(answer=3))
    status, detail = prov.status()
    assert status == "error" and "unexpected response" in detail


def test_failures_are_retried_but_throttled(prov, monkeypatch):
    fake = FakeEE(init_error=Exception("network down"))
    monkeypatch.setattr(p, "_ee", lambda: fake)
    prov.status(); prov.status()
    assert fake.init_calls == 1, "health polling must not hammer Earth Engine"
    prov._error_at -= prov.RETRY_S + 1
    fake.init_error = None
    assert prov.status()[0] == "ready" and fake.init_calls == 2
