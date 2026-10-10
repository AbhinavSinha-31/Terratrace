"""Deterministic answer checks for the AI chat (no second model call). docs/METHOD.md section 11.

The model must answer in segments:
  * general   — teaching, labelled "AI explanation". It may contain NO forest-cover or forest-change figure about any
                place (whether or not a place is named — places are never looked up in a list), and no claim that forest
                changed in a named place, a possessed place ("my village") or the selected area.
  * place     — about the selected area only. Must cite facts from TerraTrace's own data for that area; every number
                must equal a cited value (correct rounding only, matching unit and direction); no other place may appear.
  * reference — a method or dataset fact. Must cite the curated reference library; numbers must equal its values;
                no place may appear.
Any failure withholds the WHOLE answer with one reason code. The checks err on the side of withholding.
English only: anything else is withheld (the patterns below are English).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

REASONS = (
    "forest_figure_in_general", "place_change_claim_in_general", "other_place_in_place_segment",
    "unsupported_number", "uncited_place_claim", "uncited_reference", "place_in_reference",
    "non_english", "malformed", "prompt_leak",
)
KINDS = ("general", "place", "reference")
MAX_SEGMENTS = 12
MAX_SEGMENT_CHARS = 1500
MAX_ANSWER_CHARS = 5000


@dataclass(frozen=True)
class Fact:
    """A citable fact: place facts (TerraTrace result / reference context of the selected area) or reference facts."""
    id: str
    values: tuple[tuple[float, str | None], ...] = ()     # (value, unit) — the only numbers a citing segment may state
    years: tuple[int, ...] = ()
    direction: str | None = None                          # "loss" | "gain" | "signed" | None
    phrases: tuple[str, ...] = ()                         # proportion words the fact's own text uses (reference facts)


@dataclass
class Verdict:
    ok: bool
    reason: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)  # tests/diagnostics only — never logged, never shown


# ----------------------------------------------------------------------------- vocabulary
_W = r"(?<![\w-])"
_E = r"(?![\w-])"
FOREST = re.compile(_W + r"(?:forest\w*|deforest\w*|reforest\w*|afforest\w*|rain-?forests?|woodlands?|woods|trees?|"
                    r"canop(?:y|ies)|mangroves?|jungles?|logging|logged|loggers?|clear-?cut\w*|clear-?fell\w*|felled|felling|"
                    r"regrowth|timber|green\s+cover|greenery|green\s+spaces?|vegetation|plantations?|groves?|bushland|"
                    r"scrubland|burn(?:ed|t)\s+areas?|biomass|woody|carbon\s+stocks?)" + _E, re.I)
CHANGE = re.compile(_W + r"(?:lost|loss(?:es)?|los(?:e|es|ing)|declin\w*|decreas\w*|fell|fall(?:s|en|ing)?|dropp?(?:ed|s|ing)?|"
                    r"shr[aiu]nk\w*|shrink\w*|disappear\w*|destroy\w*|destruction|cleared|clearing|cut|gone|vanish\w*|"
                    r"remain\w*|gain(?:s|ed|ing)?|grew|grow\w*|increas\w*|expand\w*|expansion|rose|risen|rising|recover\w*|"
                    r"regrew|regrow\w*|degrad\w*|burn(?:ed|t|ing|s)?|deforest\w*|halved|doubled|tripled|felled|logged|"
                    r"convert\w*|conversion|encroach\w*|razed|wiped|thinn\w*|retreat\w*)" + _E, re.I)
LOSS_WORDS = re.compile(r"(?<![A-Za-z])(?:lost|loss(?:es)?|los(?:e|es|ing)|declin\w*|decreas\w*|fell|fall\w*|dropp?\w*|shr[aiu]nk\w*|"
                        r"down|disappear\w*|cleared|clearing|destroy\w*|cut|minus|fewer|less)" + _E, re.I)
GAIN_WORDS = re.compile(r"(?<![A-Za-z])(?:gain(?:s|ed|ing)?|grew|grow\w*|increas\w*|rose|risen|rising|expand\w*|recover\w*|regrew|"
                        r"regrow\w*|up|plus|more|added)" + _E, re.I)

_NUMWORDS = {
    "zero": 0, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90, "hundred": 100, "thousand": 1000, "million": 1e6, "billion": 1e9, "dozen": 12,
    "hundreds": 100, "thousands": 1000, "millions": 1e6, "billions": 1e9, "dozens": 12,
}
_NW = "|".join(sorted(_NUMWORDS, key=len, reverse=True))
# "one" counts as a number only when a unit follows ("one hectare"): it is too common in prose ("one of the").
NUMBER = re.compile(r"(?<![\w.])[+\-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])|(?<![\w.])[+\-−]?\d+(?:\.\d+)?(?![\w])"
                    rf"|{_W}(?:{_NW})(?:[\s-]+(?:{_NW}|and))*{_E}", re.I)
AREA_UNIT = (r"(?:%|percent(?:age\s+points?)?\b|per\s*cent\b|pct\b|ha\b|hectares?\b|kha\b|mha\b|km2\b|km\s*2\b|"
             r"sq\.?\s*(?:km|mi|miles?|kilomet(?:er|re)s?)\b|square\s+(?:kilomet(?:er|re)s?|miles?|met(?:er|re)s?)\b|acres?\b|"
             r"m2\b|(?:football|soccer)\s+(?:fields?|pitch(?:es)?)\b)")
_NUMEXPR = rf"(?:\d[\d,]*(?:\.\d+)?|(?:{_NW}|one|a)(?:[\s-]+(?:{_NW}|and))*)"
QTY_UNIT = re.compile(rf"{_W}{_NUMEXPR}\s*(?:(?:million|billion|thousand)\s+)?{AREA_UNIT}", re.I)
QTY_TREES = re.compile(rf"{_W}{_NUMEXPR}\s+(?:(?:million|billion|thousand)\s+)?(?:[a-z]+\s+)?trees{_E}", re.I)
# "40 bigha of forest", "3 dunams of woodland": a number, any one word, "of", a forest term — whatever the unit.
QTY_OF = re.compile(rf"{_W}{_NUMEXPR}\s+(?:[a-z.²2-]+\s+)?of\s+(?:its\s+|their\s+|the\s+)?(?:forest|woodland|tree|canop|"
                    rf"mangrove|jungle|rain-?forest|plantation|vegetation|green\s+cover|biomass)", re.I)
PROPORTION = re.compile(_W + r"(?:half|halved|halving|a\s+third|one[\s-]third|two[\s-]thirds|thirds?\s+of|a\s+quarter|"
                        r"one[\s-]quarter|three[\s-]quarters|quarters?\s+of|doubled?|doubling|tripled?|tripling|twice|thrice|"
                        r"(?:two|three|four|five|ten|\d+)-?fold|\d+\s*x)" + _E, re.I)
N_TIMES = re.compile(rf"{_W}{_NUMEXPR}\s+times{_E}", re.I)
QUANTIFIER = re.compile(_W + r"(?:most|majority|mostly|nearly\s+all|almost\s+all|much\s+of|bulk\s+of|all\s+of|nearly\s+every|"
                        r"virtually\s+all|large\s+parts?\s+of|a\s+fraction\s+of|little\s+of|none\s+of|vast\s+areas?|"
                        r"a\s+(?:large|small)\s+share)" + _E, re.I)
# A bare number (no area unit) next to these is a measurement of something else, not a forest amount.
NON_AREA_AFTER = re.compile(r"\s*(?:m\b|metres?\b|meters?\b|km\b(?!\s*2)|cm\b|mm\b|nm\b|µm\b|days?\b|weeks?\b|months?\b|years?\b|"
                            r"hours?\b|minutes?\b|seconds?\b|°|degrees?\b|bands?\b|classes\b|scenes?\b|images?\b|"
                            r"observations?\b|satellites?\b|sensors?\b|pixels?\b|percentile\b|th\b|st\b|nd\b|rd\b|times\s+a\b)",
                            re.I)
DEICTIC = re.compile(r"\b(?:this|that|the\s+selected|the\s+chosen|your|the\s+analysed|the\s+analyzed)\s+"
                     r"(?:area|region|site|place|location|aoi|study\s+area|polygon|investigation)\b"
                     r"|\bthe\s+area\s+you\s+(?:selected|chose|drew|picked)\b", re.I)
PLACE_NOUN = (r"(?:village|town|city|district|county|state|province|country|region|park|reserve|sanctuary|valley|island|"
              r"municipality|ward|neighbou?rhood|hometown|community|farm|estate|watershed|basin)")
POSSESSED_PLACE = re.compile(rf"\b(?:my|our|their|his|her)\s+(?:[a-z]+\s+)?{PLACE_NOUN}s?\b", re.I)
OTHER_PLACE = re.compile(rf"\b(?:neighbou?ring|nearby|surrounding|adjacent|other)\s+(?:[a-z]+\s+)?"
                         rf"(?:{PLACE_NOUN}|countries|areas?|regions|forests?|sites?|places?)s?\b", re.I)

# Capitalised words that are dataset, sensor, organisation or ordinary words — never places.
ALLOWED_NAMES = {
    "sentinel", "sentinel-2", "landsat", "dynamic", "world", "hansen", "worldcover", "esa", "nasa", "usgs", "google",
    "earth", "engine", "copernicus", "terratrace", "ndvi", "nbr", "swir", "nir", "modis", "fao", "umd", "university",
    "maryland", "cloud", "score", "dem", "glo-30", "glo", "gfc", "gfw", "global", "forest", "change", "watch", "ipcc",
    "co2", "i", "ai", "msi", "oli", "oli-2", "tm", "etm", "harmonized", "sr", "level", "level-2", "collection", "tier",
    "et", "al", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
    "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "v1", "v200",
    "radar", "lidar", "gedi", "sar", "rgb", "nm", "mm", "km", "ha", "fyi", "faq", "ok", "yes", "no", "reference",
    "context", "explanation", "note", "tip", "example", "examples", "q", "a",
    # ESA WorldCover class names, as the facts write them ("Tree cover", "Built-up", "Snow and ice", ...)
    "tree", "shrubland", "grassland", "cropland", "built-up", "bare", "snow", "permanent", "herbaceous", "mangroves",
    "moss",
}
# Ordinary English words that may start a sentence. A capitalised sentence-initial word NOT in here (and not seen in
# lower case elsewhere in the answer) is treated as a possible name: the check prefers withholding to missing a place.
COMMON = set("""
a about above after again against all almost also although always among an and another any are around as at be because
been before being below between both but by can cannot could did do does doing during each either even ever every few
for from further had has have having he her here hers him his how however i if in into is it its just least less like
many may maybe more most much must my near nearly neither never no nor not now of off often on once one only or other
otherwise our out over own per perhaps rather same several she should since so some such than that the their them then
there therefore these they this those though through thus to too under unless until up upon us very was we well were
what whatever when where whereas whether which while who whom whose why will with within without would yet you your
yes no first second third next finally also instead meanwhile overall today currently recently later earlier usually
generally typically sometimes still already besides similarly likewise conversely consequently importantly briefly
simply put think imagine picture consider remember note let lets see look ask try start begin compare unlike like
forest forests forestry deforestation reforestation afforestation trees tree woodland woodlands canopy canopies
logging clearing rainforest rainforests mangroves mangrove plantations plantation vegetation timber wildfire wildfires
fire fires fires burning drought droughts satellites satellite sensors sensor imagery images image pixels pixel bands band
scientists researchers maps map mapping data datasets dataset models model measurements measurement estimates
remote sensing optical infrared near shortwave visible red green blue light reflectance spectral indices index
clouds cloud shadows haze seasons season seasonal leaves leaf deciduous evergreen tropical temperate boreal dry wet
carbon biodiversity soil soils water rivers river wetlands wetland grassland grasslands cropland croplands farmland
agriculture farming farms cattle pasture pastures crops crop roads road mining cities urban rural land areas area
regions region countries country governments government people communities community local indigenous
protected parks reserves conservation restoration regrowth recovery degradation loss losses gain gains change changes
monitoring detection detecting detected classification classifier labels label probability probabilities threshold
thresholds resolution coverage observations observation composite composites annual yearly monthly daily median mean
higher lower larger smaller bigger many most each both every some no none any all only small large big long short
new old young mature dense sparse open closed natural planted native intact primary secondary healthy
good great important useful helpful common rare true false real actual exactly roughly approximately about around
over under between within across along beyond toward towards
because although though unless whereas while since so therefore hence thus
what which who why how when where whether
it this that these those there here they we you he she one
yes no not
terratrace's
net gross total totals average share shares percentage percent cover covered covering elevation elevations slope slopes
terrain mask masks result results analysis analyses window windows baseline comparison event events severity evidence
status unavailable ready invalid caution cautions statement statements land water snow ice built bare shrubland shrub
shrubs grass grasses herbaceous moss lichen sparse permanent cleared lost gained measured measuring measure measures
observed unobserved estimated reported recorded detected mapped classified compared calculated computed counted
satellite optical radar thermal multispectral hyperspectral spectrum wavelength wavelengths sunlight chlorophyll
photosynthesis leafy greenness brightness moisture temperature rainfall rain climate weather emissions storage
during after before from with without unlike compared according based using given despite except including plus
sure absolutely certainly great good interesting question questions answer answers short long quick summary overall
in on at by for of to as into onto per via
year years month months season day days decade decades century centuries time times period periods history historical
modern current past future present early late
pixels pixel scale scales grid grids tile tiles layer layers overlay legend chart charts graph timeline
humans human animals animal species wildlife birds insects
people's farmers farmer loggers miners ranchers settlers companies company policy policies laws law
fires burned burnt smoke ash
higher-resolution lower-resolution medium-resolution
""".split())
_NAME_TOKEN = re.compile(r"(?<![\w'’-])([A-Z][\w'’-]*)")
_SUFFIX_COMMON = re.compile(r"(?:ly|tion|tions|ness|ment|ments|ity|ities|ous|ive|ives)$", re.I)
# Vetted English vocabulary for SENTENCE-START words only (app/data/english_vocabulary.txt, derived from SCOWL
# 2020.12.07; see the file header): ordinary words, minus every word SCOWL also lists capitalised (proper names and
# their homographs — "China", "Turkey", "Reading" stay possible names). A word NOT in it is still a possible name, so
# unknown words keep being withheld; this is not a list of places.
_VOCAB_FILE = Path(__file__).resolve().parents[2] / "data" / "english_vocabulary.txt"


@lru_cache(maxsize=1)
def english_vocabulary() -> frozenset[str]:
    return frozenset(w.strip() for w in _VOCAB_FILE.read_text(encoding="utf-8").splitlines()
                     if w.strip() and not w.startswith("#"))
# Tokens with digits that are names of datasets/sensors/versions, removed before numbers are read.
_DATASET_TOKENS = re.compile(r"\bSentinel[-\s]?[12][ABC]?\b|\bLandsat[-\s]?\d\b|\bGLO-?30\b|\bv\d+(?:\.\d+)*\b|\btt-ee-\d+(?:\.\d+)*\b|"
                             r"\bCO2\b|\bB\d{1,2}A?\b|\bL[5789]\b|\b(?:Collection|Level|Tier)[-\s]?\d\b|\bOLI-2\b|\bS2\b|"
                             r"\[[A-Z]+\d+\]", re.I)
_YEAR_MIN, _YEAR_MAX = 1800, 2100
NON_LATIN_OK = ("LATIN", "GREEK")    # Greek: Δ in ΔNDVI
EN_STOP = set("the of and to in is a that for it as with are on by this be from or an at which its was were has have not "
              "can but their these more than also into when they there how what about only your you we our may each per "
              "if so such been other most over between will would could should do does".split())
FOREIGN_STOP = set("de la le les el los las und der die das ist que est une des du por para con una il che di och het een "
                   "nicht pas sont também não uma dos sur dans avec ich wir ein eine mit von zu auf".split())


# ----------------------------------------------------------------------------- helpers
def normalise(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "")
    t = t.replace("−", "-").replace("–", "-").replace("—", " - ").replace("’", "'")
    t = re.sub(r"[*_`#>|]", " ", t)
    return re.sub(r"[ \t]+", " ", t).strip()


def sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?;:])\s+|\n+", text) if s.strip()]


def windows(text: str) -> list[str]:
    """Each sentence together with the one before it ("Delhi has parks. It lost 40 % of its trees.")."""
    ss = sentences(text)
    return [ss[i] if i == 0 else f"{ss[i - 1]} {ss[i]}" for i in range(len(ss))] or [""]


def _num_value(tok: str) -> tuple[float, int] | None:
    """(value, decimals) of a numeric token; None for a non-number. Signs are dropped (direction is checked apart)."""
    t = tok.strip().lstrip("+-").replace(",", "")
    if re.fullmatch(r"\d+(?:\.\d+)?", t):
        return float(t), len(t.split(".")[1]) if "." in t else 0
    total, cur = 0.0, 0.0
    for w in re.split(r"[\s-]+", tok.lower()):
        if w == "and" or not w:
            continue
        v = _NUMWORDS.get(w)
        if v is None:
            return None
        if v in (100,):
            cur = (cur or 1) * v
        elif v >= 1000:
            total += (cur or 1) * v
            cur = 0
        else:
            cur += v
    return total + cur, 0


def _is_year(v: float, dec: int) -> bool:
    return dec == 0 and _YEAR_MIN <= v <= _YEAR_MAX and v == int(v)


def bare_quantities(window: str) -> list[str]:
    """Numbers in a window that are neither years, nor ≤ 1 (indices / probabilities), nor followed by a non-area unit."""
    out = []
    w = _DATASET_TOKENS.sub(" ", window)
    for m in NUMBER.finditer(w):
        nv = _num_value(m.group(0))
        if nv is None:
            continue
        v, dec = nv
        if _is_year(v, dec) or v <= 1:
            continue
        if NON_AREA_AFTER.match(w, m.end()):
            continue
        out.append(m.group(0))
    return out


def names(text: str, extra_allowed: set[str] = frozenset()) -> list[str]:
    """Capitalised tokens that may be place (or other proper) names."""
    lower_seen = {w.lower() for w in re.findall(r"\b[a-z][\w'-]*", text)}
    found = []
    for s in sentences(text):
        toks = list(_NAME_TOKEN.finditer(s))
        for i, m in enumerate(toks):
            word = m.group(1)
            base = re.sub(r"['’]s$", "", word).lower()
            if base in ALLOWED_NAMES or base in extra_allowed:
                continue
            initial = s[:m.start()].strip(" \"'([") == ""
            if initial:
                possessive = word.endswith(("'s", "’s"))
                multi = i + 1 < len(toks) and toks[i + 1].start() - m.end() <= 1   # "Western Ghats"
                if base in COMMON or (not possessive and not multi and (
                        base in lower_seen or _SUFFIX_COMMON.search(base) or base in english_vocabulary())):
                    continue
            found.append(word)
    return found


def _quant(d: Decimal, places: int) -> Decimal:
    return d.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def _unit_of(text: str, end: int) -> str | None:
    m = re.match(r"\s*(%|percent(?:age\s+points?)?\b|per\s*cent\b|points?\b|ha\b|hectares?\b|km\s*2\b|km2\b|"
                 r"square\s+kilomet(?:er|re)s?\b|m\b|metres?\b|meters?\b|°|degrees?\b)", text[end:], re.I)
    if not m:
        return None
    u = m.group(1).lower()
    if u.startswith(("%", "percent", "per", "point")):
        return "%"
    if u.startswith(("ha", "hect")):
        return "ha"
    if u.startswith(("km", "square")):
        return "km2"
    if u.startswith(("°", "deg")):
        return "deg"
    return "m"


_RESTATES = re.compile(r"\s*(?:%|ha|hectares?|km\s*2|km2|m|metres?|meters?)?\s*(?:\(|/|or|=|about|approximately|~)?\s*", re.I)


def _direction(seg: str, m: re.Match[str], depth: int = 0) -> tuple[bool, bool]:
    """(states a loss, states a gain) for the number `m`, from its own clause: the words since the previous number or
    clause break; if they state none, the words up to the next number or clause break ("measured 3,140 ha of
    forest-loss transitions"); a number that only restates the previous one in another unit ("3,140 ha (31.4 km²)")
    takes that number's direction. An explicit sign counts."""
    tok = m.group(0).strip()
    sign = tok[:1] if tok[:1] in "+-" else None
    prev_num = None
    for p in NUMBER.finditer(seg[:m.start()]):
        prev_num = p
    start = max(prev_num.end() if prev_num else 0, max(seg.rfind(c, 0, m.start()) for c in ".;!?,") + 1)
    nxt = NUMBER.search(seg, m.end())
    ends = [i for i in (seg.find(c, m.end()) for c in ".;!?,") if i != -1] + ([nxt.start()] if nxt else [])
    before, after = seg[start:m.start()], seg[m.end():min(ends) if ends else len(seg)]
    loss, gain = bool(LOSS_WORDS.search(before)), bool(GAIN_WORDS.search(before))
    if not (loss or gain):
        loss, gain = bool(LOSS_WORDS.search(after)), bool(GAIN_WORDS.search(after))
    if not (loss or gain or sign) and prev_num is not None and depth < 3 \
            and _RESTATES.fullmatch(seg[prev_num.end():m.start()]):
        return _direction(seg, prev_num, depth + 1)
    return loss or sign == "-", gain or sign == "+"


def _number_supported(seg: str, m: re.Match[str], facts: list[Fact]) -> bool:
    nv = _num_value(m.group(0))
    if nv is None:
        return True
    v, dec = nv
    unit = _unit_of(seg, m.end())
    says_loss, says_gain = _direction(seg, m)
    if unit is None and _is_year(v, dec) and any(int(v) in f.years for f in facts):
        return True
    target = _quant(Decimal(repr(v)), dec)
    for f in facts:
        for fv, fu in f.values:
            if unit is not None and fu is not None and unit != fu:
                continue
            if unit is not None and fu is None:
                continue
            if _quant(Decimal(repr(abs(fv))), dec) != target:
                continue
            # Direction: a loss, gain or signed figure must be STATED with its direction (a word in its clause, or the
            # sign), so it cannot be passed off as a level ("forest area was 3,140 ha") or as the opposite change.
            if f.direction == "loss" and not (says_loss and not says_gain):
                continue
            if f.direction == "gain" and not (says_gain and not says_loss):
                continue
            if f.direction == "signed" and not ((fv < 0 and says_loss and not says_gain) or (fv > 0 and says_gain and not says_loss)):
                continue
            return True
    return False


# ----------------------------------------------------------------------------- checks per segment kind
# "that area" refers to the selected area unless the same sentence first introduces an INDEFINITE area it can point
# back to ("how much forest a specific area has lost ... select that area on the map"). "this area", "the selected
# area", "your area" always refer to the selected area.
_INDEFINITE_AREA = re.compile(r"\b(?:a|an|any|some|each|every|another)\s+(?:[a-z-]+\s+){0,2}"
                              r"(?:area|region|site|place|location|polygon)\b", re.I)


def refers_to_selected_area(window: str) -> bool:
    for m in DEICTIC.finditer(window):
        if not m.group(0).lower().startswith("that "):
            return True
        sentence_start = max(window.rfind(c, 0, m.start()) for c in ".!?;") + 1
        if not _INDEFINITE_AREA.search(window[sentence_start:m.start()]):
            return True
    return False


def check_general(text: str) -> str | None:
    # Forest figures: the WHOLE segment is one window (a figure three sentences after "forest" is still about it).
    # Named-place change claims: a sentence and the one before it (whole paragraphs would withhold ordinary teaching).
    if FOREST.search(text):
        change = CHANGE.search(text)
        if QTY_UNIT.search(text) or QTY_TREES.search(text) or QTY_OF.search(text) or PROPORTION.search(text) \
                or N_TIMES.search(text) or (change and QUANTIFIER.search(text)) or (change and bare_quantities(text)):
            return "forest_figure_in_general"
    # A figure in text with no English word at all cannot be checked ("Bosque perdido: 40 %").
    if QTY_UNIT.search(text) and not any(w in EN_STOP for w in re.findall(r"[a-z']+", text.lower())):
        return "non_english"
    for w in windows(text):
        if FOREST.search(w):
            change = CHANGE.search(w)
            if refers_to_selected_area(w) or (change and (POSSESSED_PLACE.search(w) or names(w))):
                return "place_change_claim_in_general"
    return None


def check_numbers(text: str, facts: list[Fact]) -> bool:
    t = _DATASET_TOKENS.sub(" ", text)
    for m in NUMBER.finditer(t):
        if not _number_supported(t, m, facts):
            return False
    for m in list(PROPORTION.finditer(t)) + list(N_TIMES.finditer(t)) + list(QUANTIFIER.finditer(t)):
        phrase = re.sub(r"\s+", " ", m.group(0).lower())
        if not any(phrase in f.phrases for f in facts):
            return False
    # "one hectare", "one per cent": "one" is a number when a unit follows.
    for m in re.finditer(r"\bone\b", t, re.I):
        if _unit_of(t, m.end()) is not None and not any(1.0 == abs(fv) for f in facts for fv, _ in f.values):
            return False
    return True


def check_place(text: str, cited: list[str], place_facts: dict[str, Fact], ref_facts: dict[str, Fact],
                area_names: set[str]) -> str | None:
    if not any(c in place_facts for c in cited):
        return "uncited_place_claim"
    if any(c not in place_facts and c not in ref_facts for c in cited):
        return "uncited_place_claim"
    if names(text, area_names) or POSSESSED_PLACE.search(text) or OTHER_PLACE.search(text):
        return "other_place_in_place_segment"
    facts = [place_facts[c] for c in cited if c in place_facts] + [ref_facts[c] for c in cited if c in ref_facts]
    # A change claim without a number may not contradict the sign of the cited net change ("forest increased" citing
    # a negative net change).
    signed = [fv for f in facts if f.direction == "signed" for fv, _ in f.values]
    if signed and not any(f.direction in ("loss", "gain") for f in facts):
        up, down = bool(GAIN_WORDS.search(text)), bool(LOSS_WORDS.search(text))
        if (all(v < 0 for v in signed) and up and not down) or (all(v > 0 for v in signed) and down and not up):
            return "unsupported_number"
    return None if check_numbers(text, facts) else "unsupported_number"


def check_reference(text: str, cited: list[str], place_facts: dict[str, Fact], ref_facts: dict[str, Fact]) -> str | None:
    if any(c in place_facts for c in cited):
        return "place_in_reference"
    if not cited or any(c not in ref_facts for c in cited):
        return "uncited_reference"
    if names(text) or POSSESSED_PLACE.search(text) or OTHER_PLACE.search(text) or DEICTIC.search(text):
        return "place_in_reference"
    return None if check_numbers(text, [ref_facts[c] for c in cited]) else "unsupported_number"


def is_english(text: str) -> bool:
    for ch in text:
        if ch.isalpha():
            try:
                script = unicodedata.name(ch).split(" ")[0]
            except ValueError:
                return False
            if script not in NON_LATIN_OK:
                return False
    words = re.findall(r"[a-zà-ÿ']+", text.lower())
    if len(words) < 6:
        return True
    en = sum(w in EN_STOP for w in words)
    foreign = sum(w in FOREIGN_STOP for w in words)
    if foreign >= 3 and foreign > en:
        return False
    return not (len(words) >= 8 and en / len(words) < 0.08)


def validate(answer: Any, place_facts: dict[str, Fact], ref_facts: dict[str, Fact], area_names: set[str],
             leak_markers: tuple[str, ...] = ()) -> Verdict:
    """Check one parsed model answer {"in_scope": bool, "segments": [{"kind", "text", "fact_ids"}]}."""
    if not isinstance(answer, dict) or not isinstance(answer.get("segments"), list) or not isinstance(answer.get("in_scope"), bool):
        return Verdict(False, "malformed")
    segs = answer["segments"]
    if answer["in_scope"] is False:
        return Verdict(True)            # declined: the caller shows a fixed message, never the model's text
    if not segs or len(segs) > MAX_SEGMENTS:
        return Verdict(False, "malformed")
    total = 0
    for s in segs:
        if (not isinstance(s, dict) or s.get("kind") not in KINDS or not isinstance(s.get("text"), str) or not s["text"].strip()
                or len(s["text"]) > MAX_SEGMENT_CHARS or not isinstance(s.get("fact_ids", []), list)
                or not all(isinstance(x, str) for x in s.get("fact_ids", []))):
            return Verdict(False, "malformed")
        total += len(s["text"])
    if total > MAX_ANSWER_CHARS:
        return Verdict(False, "malformed")
    raw = " ".join(s["text"] for s in segs)
    if any(m and m.lower() in raw.lower() for m in leak_markers) or "AIza" in raw:
        return Verdict(False, "prompt_leak")
    if not is_english(normalise(raw)):
        return Verdict(False, "non_english")
    allowed_area = {w.lower() for n in area_names for w in re.findall(r"[\w'-]+", n)}
    for i, s in enumerate(segs):
        text, cited = normalise(s["text"]), list(dict.fromkeys(s.get("fact_ids", [])))
        if s["kind"] == "general":
            r = check_general(text)
        elif s["kind"] == "place":
            r = check_place(text, cited, place_facts, ref_facts, allowed_area)
        else:
            r = check_reference(text, cited, place_facts, ref_facts)
        if r:
            return Verdict(False, r, {"segment": i})
    return Verdict(True)
