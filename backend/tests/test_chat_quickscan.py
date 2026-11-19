"""Phase D (docs/QUICKSCAN_PLAN.md): the chat may quote a stored quick scan as cited facts — through the same validator,
with three extra rules: Dynamic World "Trees" is never forest cover, biomass carbon is never total / ecosystem / soil
carbon, and quick-scan figures are never a TerraTrace classification.

The stored scan is built from tests/test_quickscan.RAW, a SYNTHETIC fixture (round numbers; never a measurement).
"""

import json

import pytest

from app.services import quickscan
from app.services.chat import facts as chat_facts
from app.services.chat import prompt
from app.services.chat import validator as V
from test_quickscan import RAW

AID = "hasdeo-arand"
AREA = {"Hasdeo Arand Forest", "Hasdeo Arand", "Chhattisgarh, Central India", "India"}
_, REF, _ = chat_facts.reference_facts()


@pytest.fixture
def stored_scan():
    """A stored quick scan of Hasdeo Arand (2025, all months), written where the service keeps scans."""
    for f in quickscan.CACHE.glob("*.json") if quickscan.CACHE.exists() else []:
        f.unlink()
    doc = quickscan.parse(json.loads(json.dumps(RAW)), year=2025, season="all")
    doc = {**quickscan._envelope(AID, 2025, "all", doc["status"]), **doc, "aoi_id": AID, "quickscan_version": quickscan.version(),
           "computed_at": "2026-10-22T00:00:00+00:00", "elapsed_s": 1.0}
    quickscan.CACHE.mkdir(parents=True, exist_ok=True)
    (quickscan.CACHE / f"{AID}-2025-all-{quickscan.version()}.json").write_text(json.dumps(doc), encoding="utf-8")
    yield doc
    for f in quickscan.CACHE.glob("*.json"):
        f.unlink()


@pytest.fixture
def facts(stored_scan):
    prompt_facts, index, public, names, _name = chat_facts.place_facts(AID, (2019, 2025))
    by_label = {p["label"]: p["id"] for p in prompt_facts}
    return prompt_facts, index, public, by_label


def fid(by_label, start):
    hits = [i for label, i in by_label.items() if label.startswith(start)]
    assert len(hits) == 1, (start, hits)
    return hits[0]


def check(text, ids, index):
    v = V.validate({"in_scope": True, "segments": [{"kind": "place", "text": text, "fact_ids": list(ids)}]}, index, REF, AREA)
    return v.reason if not v.ok else None


# ----------------------------------------------------------------------------- facts
def test_stored_quick_scans_become_labelled_place_facts(facts):
    prompt_facts, index, public, by_label = facts
    qs = [p for p in prompt_facts if p["kind"].startswith("Quick scan")]
    assert qs and all("not a TerraTrace classification" in p["kind"] for p in qs)
    trees = fid(by_label, "Dynamic World 2025 land cover: Trees")
    assert "not forest cover" in next(p["label"] for p in prompt_facts if p["id"] == trees)
    assert index[trees].tags == ("dw_trees", "quick_scan") and public[trees]["kind"] == "quick_scan"
    carbon = fid(by_label, "Carbon density")
    assert index[carbon].tags == ("biomass_carbon", "quick_scan")
    assert any("roots, dead wood, litter and soil not included" in label for label in by_label)
    assert all(p["dataset"] and p["year"] for p in qs), "every quick-scan fact carries its dataset and year"


def test_no_stored_scan_no_quick_scan_facts():
    for f in quickscan.CACHE.glob("*.json") if quickscan.CACHE.exists() else []:
        f.unlink()
    prompt_facts, *_ = chat_facts.place_facts(AID, (2019, 2025))
    assert not any(p["kind"].startswith("Quick scan") for p in prompt_facts)


def test_the_prompt_explains_how_quick_scan_facts_may_be_described():
    text = prompt.system_instruction("Hasdeo Arand", [], [])
    assert prompt.PROMPT_VERSION == "chat-5"
    for must in ("never call it forest cover", "never call it total, ecosystem or soil carbon", "never \"TerraTrace's classification\""):
        assert must in text


# ----------------------------------------------------------------------------- land cover (Dynamic World)
def test_dynamic_world_trees_quoted_as_land_cover_passes(facts):
    _, index, _, by_label = facts
    t = fid(by_label, "Dynamic World 2025 land cover: Trees")
    assert check("In a 2025 quick scan from public datasets, Dynamic World mapped 30.0 km² (30.0 %) of this area as Trees.", [t], index) is None
    assert check("Dynamic World classed 3,000 ha of this area as trees in 2025.", [t], index) is None


@pytest.mark.parametrize("text", [
    "Forest cover in this area was 30.0 km² in 2025, according to Dynamic World.",
    "In 2025, 30.0 km² were trees, which is the forest area here.",
    "Dynamic World shows 30.0 % forest in this area in 2025.",
    "The area had 3,000 ha of rainforest in 2025 (Dynamic World Trees).",
])
def test_dynamic_world_trees_never_pass_as_forest_cover(facts, text):
    _, index, _, by_label = facts
    assert check(text, [fid(by_label, "Dynamic World 2025 land cover: Trees")], index) == "trees_as_forest"


def test_a_decimal_point_does_not_hide_the_forest_word(facts):
    _, index, _, by_label = facts
    t = fid(by_label, "Dynamic World 2025 land cover: Trees")
    assert check("Trees covered 30.0 km² in 2025, the forest of this area.", [t], index) == "trees_as_forest"


def test_terratraces_own_forest_figure_next_to_trees_is_not_blocked(facts):
    """'forest' in the sentence is fine when the number it qualifies is NOT only a Dynamic World trees figure."""
    _, index, _, by_label = facts
    built = fid(by_label, "Dynamic World 2025 land cover: Built area")
    assert check("Dynamic World mapped 20.0 km² as built area in 2025, next to the forest.", [built], index) is None


def test_a_wrong_land_cover_number_is_withheld(facts):
    _, index, _, by_label = facts
    assert check("Dynamic World mapped 35.0 km² of this area as Trees in 2025.", [fid(by_label, "Dynamic World 2025 land cover: Trees")], index) == "unsupported_number"


def test_quick_scan_figures_are_never_a_terratrace_classification(facts):
    _, index, _, by_label = facts
    t = fid(by_label, "Dynamic World 2025 land cover: Crops")
    assert check("TerraTrace's classification shows 40.0 km² of crops in this area in 2025.", [t], index) == "quick_scan_as_terratrace"
    assert check("A quick scan with Dynamic World shows 40.0 km² of crops in this area in 2025.", [t], index) is None


# ----------------------------------------------------------------------------- temperature (°C)
def test_land_surface_temperature_in_celsius(facts):
    _, index, _, by_label = facts
    mean = fid(by_label, "Land surface temperature, all months 2025, mean of land")
    assert check("The mean land surface temperature of this area in 2025 was 35.2 °C (Landsat, all months).", [mean], index) is None
    assert check("Landsat measured a mean of 35.2 degrees Celsius here in 2025.", [mean], index) is None
    assert check("The mean land surface temperature of this area in 2025 was 37.5 °C.", [mean], index) == "unsupported_number"
    # °C is not a slope in degrees, and a temperature is not an area
    assert check("The mean was 35.2 % in 2025.", [mean], index) == "unsupported_number"


def test_the_heat_island_figure_must_say_warmer_for_a_positive_value(facts):
    _, index, _, by_label = facts
    uhi = fid(by_label, "Simple surface UHI")
    assert check("In 2025, built-up land in this area was 3.1 °C warmer than the other land (simple surface UHI).", [uhi], index) is None
    assert check("The simple surface UHI here was +3.1 °C in 2025.", [uhi], index) is None
    assert check("In 2025, built-up land in this area was 3.1 °C cooler than the other land.", [uhi], index) == "unsupported_number"
    assert check("The simple surface UHI here was 3.1 °C in 2025.", [uhi], index) == "unsupported_number", "no direction stated"


# ----------------------------------------------------------------------------- carbon (t C/ha, t C)
def test_biomass_carbon_density_and_total(facts):
    _, index, _, by_label = facts
    dens, tot = fid(by_label, "Carbon density"), fid(by_label, "Carbon in the area")
    assert check("Above-ground tree biomass carbon here is 23.5 t C/ha (ESA CCI 2022).", [dens], index) is None
    assert check("In total that is about 223.3 kt C of above-ground tree biomass carbon (ESA CCI 2022), with a range of 134.0–312.6 kt C.", [tot], index) is None
    assert check("ESA CCI 2022 gives 223,250 tonnes of carbon in above-ground tree biomass here.", [tot], index) is None
    assert check("Above-ground tree biomass carbon here is 23.5 ha (ESA CCI 2022).", [dens], index) == "unsupported_number"
    assert check("Above-ground tree biomass carbon here is 25.0 t C/ha (ESA CCI 2022).", [dens], index) == "unsupported_number"


@pytest.mark.parametrize("text", [
    "The total carbon stock of this area is 223.3 kt C (ESA CCI 2022).",
    "This area stores 23.5 t C/ha of ecosystem carbon (ESA CCI 2022).",
    "Including the soil, the area holds 223.3 kt C (ESA CCI 2022).",
])
def test_biomass_carbon_is_never_total_or_soil_carbon(facts, text):
    _, index, _, by_label = facts
    assert check(text, [fid(by_label, "Carbon density"), fid(by_label, "Carbon in the area")], index) == "carbon_overclaim"


def test_saying_what_carbon_excludes_is_fine(facts):
    _, index, _, by_label = facts
    assert check("ESA CCI 2022 gives 23.5 t C/ha of above-ground tree biomass carbon here, not including soil carbon.",
                 [fid(by_label, "Carbon density")], index) is None


def test_quick_scan_figures_in_a_general_segment_are_still_withheld(facts):
    v = V.validate({"in_scope": True, "segments": [{"kind": "general", "text": "This area has 30.0 km² of trees.", "fact_ids": []}]},
                   facts[1], REF, AREA)
    assert not v.ok and v.reason == "forest_figure_in_general"


# ----------------------------------------------------------------------------- Phase 4 metrics in the chat (grounding)
def test_vegetated_uhi_and_merged_classes_are_citable_facts(facts):
    _, index, _, by_label = facts
    veg = fid(by_label, "Surface UHI against vegetated land")
    assert check("Built-up land was about 3.7 °C warmer than vegetated land.", [veg], index) is None
    assert check("Built-up land was about 5.2 °C warmer than vegetated land.", [veg], index), "an invented figure is withheld"


def test_carbon_series_is_citable_only_when_stored(facts):
    from app.services import carbon_series
    carbon_series._memory.clear()
    _, _, _, by_label = facts
    assert not [label for label in by_label if label.startswith("Estimated above-ground tree carbon")]
    raw = {"2015": {"area_ha": 1e4, "covered_ha": 9e3, "agb_x_ha": 9e3 * 100, "sd_x_ha": 9e3 * 20},
           "2022": {"area_ha": 1e4, "covered_ha": 9e3, "agb_x_ha": 9e3 * 80, "sd_x_ha": 9e3 * 20}}
    carbon_series._memory[AID] = {**carbon_series.parse(raw), "aoi_id": AID}
    try:
        labels, index, *_ = chat_facts.place_facts(AID, (2019, 2025))
        by = {p["label"]: p["id"] for p in labels}
        change = fid(by, "Change in estimated above-ground tree carbon")
        assert check("Estimated above-ground tree carbon fell by about 84.6 kt C between 2015 and 2022.", [change], index) is None
    finally:
        carbon_series._memory.clear()


def test_api_ask_is_the_chat_endpoint_with_the_same_limit():
    from fastapi.testclient import TestClient
    from app import ratelimit
    from app.main import app
    c = TestClient(app)
    body = {"messages": [{"role": "user", "text": "What is NDVI?"}]}
    a, b = c.post("/api/ask", json=body), c.post("/api/chat", json=body)
    assert a.status_code == b.status_code == 200 and a.json()["reason_code"] == b.json()["reason_code"]
    assert ratelimit.group_of("POST", "/api/ask") == ratelimit.group_of("POST", "/api/chat") == "chat"
    assert ratelimit.group_of("POST", "/api/ask/stream") == "chat"
