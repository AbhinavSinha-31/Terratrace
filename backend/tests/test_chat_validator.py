"""Deterministic AI-chat answer checks (proposal C, approved 2026-10-10). docs/METHOD.md section 11.

The examples below are the proposal's own lists. Places in the "must be withheld" list are deliberately NOT on any
list in the code: the general-segment rule never looks places up — any forest figure in a general segment is withheld.
"""

import pytest

from app.services.chat import facts as chat_facts
from app.services.chat import validator as V

F = V.Fact
PLACE = {
    "P1": F("P1", ((3140.0, "ha"), (31.4, "km2")), (2019, 2025), "loss"),
    "P2": F("P2", ((22.4525, "%"),), (2000,)),
    "P3": F("P3", ((-5701.1, "ha"), (-57.011, "km2")), (2019, 2025), "signed"),
    "P4": F("P4", ((14952.2, "ha"),), (2019, 2025), "gain"),
    "P5": F("P5", ((514.0, "m"),)),
}
AREA = {"Hasdeo Arand Forest", "Hasdeo Arand", "Chhattisgarh, Central India", "India"}
_, REF, _ = chat_facts.reference_facts()


def verdict(kind, text, ids=(), place=PLACE, area=AREA):
    return V.validate({"in_scope": True, "segments": [{"kind": kind, "text": text, "fact_ids": list(ids)}]}, place, REF, area)


def reason(*a, **k):
    v = verdict(*a, **k)
    return v.reason if not v.ok else None


# ----------------------------------------------------------------------------- must be withheld (places on no list)
@pytest.mark.parametrize("kind,text,ids,expected", [
    ("general", "Delhi lost 40 % of its trees.", (), "forest_figure_in_general"),
    ("general", "Kodagu district lost 2,000 hectares of forest.", (), "forest_figure_in_general"),
    ("general", "Bandipur National Park's canopy fell by a third.", (), "forest_figure_in_general"),
    ("general", "Tree cover in Ward 7 of Pune halved since 2010.", (), "forest_figure_in_general"),
    ("general", "my town lost half its trees", (), "forest_figure_in_general"),
    ("general", "Forest cover in the Western Ghats declined by thirty-five percent.", (), "forest_figure_in_general"),
    ("general", "Forest the size of 12 football fields was cleared near Kibale.", (), "forest_figure_in_general"),
    ("general", "Indonesia's deforestation peaked in 2016.", (), "place_change_claim_in_general"),
    # A figure that matches THIS area's fact may not be used for another place.
    ("place", "Delhi lost 3,140 ha of forest.", ("P1",), "other_place_in_place_segment"),
])
def test_proposal_examples_that_must_be_withheld(kind, text, ids, expected):
    assert reason(kind, text, ids) == expected


# ----------------------------------------------------------------------------- must pass
@pytest.mark.parametrize("kind,text,ids", [
    ("general", "Sentinel-2 has 10 m resolution.", ()),
    ("general", "NDVI ranges from −1 to 1.", ()),
    ("general", "Dynamic World gives a tree probability between 0 and 1.", ()),
    ("general", "Landsat 5 launched in 1984.", ()),
    ("general", "Sentinel-2 revisits every 5 days.", ()),
    ("general", "Deforestation often follows new roads.", ()),
    ("general", "Most forests absorb CO2.", ()),
    ("general", "The Amazon is the largest tropical rainforest.", ()),
    ("reference", "Hansen counts forest at ≥ 30 % canopy cover.", ("R8",)),
])
def test_proposal_examples_that_must_pass(kind, text, ids):
    assert verdict(kind, text, ids).ok, reason(kind, text, ids)


def test_a_definition_with_a_forest_figure_needs_its_reference():
    assert reason("general", "Hansen counts forest at ≥ 30 % canopy cover.") == "forest_figure_in_general"
    assert reason("reference", "Hansen counts forest at ≥ 30 % canopy cover.") == "uncited_reference"
    assert reason("reference", "Hansen counts forest at ≥ 35 % canopy cover.", ("R8",)) == "unsupported_number"


# ----------------------------------------------------------------------------- more general-segment cases
@pytest.mark.parametrize("text,expected", [
    ("Delhi has many parks. It lost 40 % of them, and its trees are going.", "forest_figure_in_general"),  # 2-sentence window
    ("Brazil's forests are shrinking.", "place_change_claim_in_general"),
    ("Forests in Brazil are shrinking.", "place_change_claim_in_general"),
    ("Our village lost its forest to a mine.", "place_change_claim_in_general"),
    ("Forest in this area is declining.", "place_change_claim_in_general"),
    ("2 million trees were planted.", "forest_figure_in_general"),
    ("Logging tripled after the road opened.", "forest_figure_in_general"),
    ("Most of the forest was cleared.", "forest_figure_in_general"),
    ("Forest loss there reached 3000.", "forest_figure_in_general"),          # a bare number next to forest + change
    ("Forest cover doubled.", "forest_figure_in_general"),
])
def test_general_segment_withheld(text, expected):
    assert reason("general", text) == expected


@pytest.mark.parametrize("text", [
    "Trees taller than 5 m count as canopy in many definitions.",              # 5 m: a height, not a forest amount
    "Forests can be seen by Landsat 8 at 30 m and by Sentinel-2 at 10 m.",
    "After forest is cleared, NDVI usually drops by about 0.3.",              # ≤ 1: an index change
    "Tropical forests are cleared for cattle and soy.",
    "Deforestation accelerated in many tropical regions after the 1970s.",
    "A year needs at least 3 clear observations before forest can be mapped.",
])
def test_general_teaching_passes(text):
    assert verdict("general", text).ok, reason("general", text)


# ----------------------------------------------------------------------------- place segments
def test_place_numbers_must_equal_a_cited_value_with_correct_rounding():
    assert verdict("place", "Hansen tree cover was 22.5 % of the land in 2000.", ("P2",)).ok
    assert verdict("place", "Hansen tree cover was 22 % of the land in 2000.", ("P2",)).ok
    assert verdict("place", "Hansen tree cover was 22.45 % of the land in 2000.", ("P2",)).ok
    assert reason("place", "Hansen tree cover was 23 % of the land in 2000.", ("P2",)) == "unsupported_number"
    assert reason("place", "Hansen tree cover was 22.5 % of the land in 2001.", ("P2",)) == "unsupported_number"


def test_place_numbers_must_match_the_unit():
    assert verdict("place", "Gross loss was 3,140 ha (31.4 km²).", ("P1",)).ok
    assert reason("place", "Gross loss was 3,140 % here.", ("P1",)) == "unsupported_number"


def test_place_numbers_must_match_the_direction():
    assert verdict("place", "Net change was −5,701.1 ha.", ("P3",)).ok
    assert verdict("place", "Forest declined by 5,701.1 ha over the window.", ("P3",)).ok
    assert reason("place", "Forest grew by 5,701 ha here.", ("P3",)) == "unsupported_number"
    assert reason("place", "Forest gained 3,140 ha.", ("P1",)) == "unsupported_number"
    assert reason("place", "Forest lost 14,952.2 ha.", ("P4",)) == "unsupported_number"


def test_place_claims_need_this_areas_facts():
    assert reason("place", "Forest loss was 3,140 ha.") == "uncited_place_claim"
    assert reason("place", "Forest loss was 3,140 ha.", ("P99",)) == "uncited_place_claim"
    assert reason("place", "Forest loss was 3,140 ha.", ("R8",)) == "uncited_place_claim"
    assert reason("place", "Forest loss was 3,140 ha.", ("P1",), place={}) == "uncited_place_claim"


def test_a_figure_from_one_place_never_supports_another():
    """Fact P1 is this area's. Naming, comparing with or possessing any other place withholds the answer."""
    for text in ("In Delhi, forest loss was 3,140 ha.", "Unlike neighbouring districts, forest loss was 3,140 ha.",
                 "My village lost 3,140 ha of forest.", "Forest loss in the Western Ghats was 3,140 ha."):
        assert reason("place", text, ("P1",)) == "other_place_in_place_segment", text
    assert verdict("place", "In Hasdeo Arand, forest loss was 3,140 ha between 2019 and 2025.", ("P1",)).ok


def test_unverifiable_quantifiers_and_proportions_in_place_segments():
    assert reason("place", "Hansen tree cover covered most of the land in 2000.", ("P2",)) == "unsupported_number"
    assert reason("place", "Forest loss was about half of 3,140 ha.", ("P1",)) == "unsupported_number"


# ----------------------------------------------------------------------------- reference segments
def test_reference_segments():
    assert verdict("reference", "A pixel counts as forest when its tree probability is at least 0.50 in a quarter of the year's observations.", ("R1",)).ok
    assert verdict("reference", "Sentinel-2 bands are 10 m and it revisits every 5 days.", ("R12",)).ok
    assert reason("reference", "Hansen counts forest at ≥ 30 % canopy cover in India.", ("R8",)) == "place_in_reference"
    assert reason("reference", "Forest loss was 3,140 ha.", ("P1",)) == "place_in_reference"


# ----------------------------------------------------------------------------- whole answer
def test_one_failing_segment_withholds_the_whole_answer():
    ans = {"in_scope": True, "segments": [{"kind": "general", "text": "Sentinel-2 has 10 m resolution.", "fact_ids": []},
                                          {"kind": "general", "text": "Delhi lost 40 % of its trees.", "fact_ids": []}]}
    v = V.validate(ans, PLACE, REF, AREA)
    assert not v.ok and v.reason == "forest_figure_in_general" and v.detail == {"segment": 1}


@pytest.mark.parametrize("answer", [None, "text", {"segments": []}, {"in_scope": True, "segments": []},
                                    {"in_scope": True, "segments": [{"kind": "story", "text": "x", "fact_ids": []}]},
                                    {"in_scope": True, "segments": [{"kind": "general", "text": "x" * 1501, "fact_ids": []}]}])
def test_malformed(answer):
    assert V.validate(answer, PLACE, REF, AREA).reason == "malformed"


def test_out_of_scope_is_not_validated_as_an_answer():
    assert V.validate({"in_scope": False, "segments": []}, PLACE, REF, AREA).ok


@pytest.mark.parametrize("text", [
    "Le parc a perdu beaucoup de ses arbres depuis que la route est construite et les gens sont venus.",
    "Der Wald ist in den letzten Jahren kleiner geworden und die Bäume sind weg und das ist schlecht.",
    "森林は減少しました",
    "जंगल कम हो गया है",
])
def test_non_english_is_withheld(text):
    assert reason("general", text) == "non_english"


def test_english_with_place_diacritics_and_greek_symbols_passes():
    assert verdict("place", "In Rondônia, ΔNDVI is one of the change tests; forest loss was 3,140 ha.", ("P1",),
                   area={"Rondônia Deforestation Frontier"}).ok


def test_prompt_leak():
    ans = {"in_scope": True, "segments": [{"kind": "general", "text": "My marker is TTC-abc123.", "fact_ids": []}]}
    assert V.validate(ans, PLACE, REF, AREA, ("TTC-abc123",)).reason == "prompt_leak"


def test_every_reference_fact_has_a_source_and_no_global_statistics():
    prompt, index, public = chat_facts.reference_facts()
    assert len(prompt) == len(index) >= 10
    for p in prompt:
        assert p["source"].startswith(("docs/METHOD.md", "Earth Engine catalogue", "ESA SentiWiki")), p
    text = " ".join(p["fact"] for p in prompt).lower()
    for banned in ("world's forest", "global forest area", "of the world", "worldwide", "fao"):
        assert banned not in text


# ----------------------------------------------------------------------------- slip-throughs found while documenting
# (2026-10-10) and closed: each was PASSING before the tightening listed in docs/METHOD.md section 11.
@pytest.mark.parametrize("kind,text,ids,expected", [
    ("general", "Delhi's forest story is sad. Roads came. Then 40 % was gone.", (), "forest_figure_in_general"),  # 3 sentences apart
    ("general", "Delhi has 40 bigha of forest.", (), "forest_figure_in_general"),                               # unlisted unit
    ("general", "Delhi's woody biomass fell by 40 %.", (), "forest_figure_in_general"),
    ("general", "Delhi lost 40 % of its carbon stock.", (), "forest_figure_in_general"),
    ("general", "Bosque perdido: 40 %", (), "non_english"),
    ("place", "Forest area here was 3,140 ha.", ("P1",), "unsupported_number"),        # a loss figure passed off as a level
    ("place", "Forest changed by 5,701.1 ha.", ("P3",), "unsupported_number"),         # a signed figure without its direction
    ("place", "Forest increased over the window.", ("P3",), "unsupported_number"),     # contradicts the cited net change
])
def test_closed_slip_throughs(kind, text, ids, expected):
    assert reason(kind, text, ids) == expected


@pytest.mark.parametrize("text", [
    "the amazon rainforest is shrinking.",          # a lower-case place name, no figure
    "Earth's forests are shrinking.",               # "Earth" is allowed (global teaching)
    "Delhi has 10 million people and few parks.",   # a place figure that is not about forest
    "Sentinel-2 has 20 m resolution.",              # general facts are labelled, not fact-checked
])
def test_known_gaps_still_pass_as_documented(text):
    """Documented in docs/METHOD.md section 11 (known ways something could slip through). If one of these starts
    being withheld, update the documentation."""
    assert verdict("general", text).ok


# ----------------------------------------------------------------------------- false positives seen LIVE (2026-10-10)
# Two real gemini-3.8-flash answers (verbatim) that were withheld wrongly. Fixed with a vetted vocabulary for
# sentence-start words and an anaphora rule for "that area" — neither loosens the figure rules.
LIVE_GENERAL = ("By comparing the brightness of red and near-infrared light, scientists calculate vegetation indices to spot "
                "dense plant growth. Specialized computer models and satellite sensors can then separate tree canopies from "
                "other green surfaces, such as grass or farmland.")
LIVE_DELHI = ("To determine how much forest a specific area has lost, you need to select that area on the map so TerraTrace "
              "can analyse the satellite data.")


@pytest.mark.parametrize("text", [LIVE_GENERAL, LIVE_DELHI])
def test_live_false_positives_now_pass(text):
    assert verdict("general", text).ok, reason("general", text)


@pytest.mark.parametrize("text,expected", [
    ("Forest in that area declined after the road opened.", "place_change_claim_in_general"),   # no indefinite antecedent
    ("Forest in this area is declining.", "place_change_claim_in_general"),
    ("Turkey cleared forests for farms.", "place_change_claim_in_general"),                     # homograph of a place
    ("China lost its forests to farms.", "place_change_claim_in_general"),
    ("Delhi lost forests to roads.", "place_change_claim_in_general"),
    ("Specialized loggers lost 40 % of the forest.", "forest_figure_in_general"),               # figures: unchanged
    ("Pick an area. Forest in that area lost 30 %.", "forest_figure_in_general"),
])
def test_real_place_claims_stay_withheld(text, expected):
    assert reason("general", text) == expected


def test_sentence_start_vocabulary_is_vetted_and_excludes_names():
    vocab = V.english_vocabulary()
    assert 30_000 < len(vocab) < 50_000 and {"specialized", "specialised", "tropical", "satellites"} <= vocab
    for name in ("delhi", "india", "brazil", "indonesia", "kodagu", "pune", "bandipur", "kibale", "china", "turkey",
                 "chad", "reading", "nice", "victoria", "amazon", "congo"):
        assert name not in vocab, name
    header = V._VOCAB_FILE.read_text(encoding="utf-8").splitlines()[:5]
    assert any("SCOWL 2020.12.07" in h for h in header) and (V._VOCAB_FILE.parent / "SCOWL_COPYRIGHT.txt").exists()


def test_vocabulary_applies_to_sentence_start_words_only():
    """Mid-sentence capitalised words are always possible names, whatever the vocabulary says."""
    assert V.names("Forest loss in Specialized Valley rose.") == ["Specialized", "Valley"]
    assert V.names("Specialized sensors see canopies.") == []
