"""Answers in the user's language (Hindi / Hinglish) without weakening the checks.

The ENGLISH text of every segment is the answer: it is what services/chat/validator.py checks, unchanged. When the
user writes in Hindi (Devanagari) or Hinglish (Hindi in Latin letters), the model also returns the same segment in that
language as `text_local`. A translation is shown only if EVERY segment's translation passes all of these checks against
its own checked English segment; otherwise ALL translations are dropped and the checked English answer is shown
(never the reverse):

  numbers   exactly the same numbers (Devanagari digits normalised; nothing added, dropped or changed)
  names     no Latin-script capitalised word that the English segment does not contain (an added "Delhi" in Hinglish)
  length    not much longer than the English (a translation adds nothing)
  script    Devanagari for Hindi; Latin letters for Hinglish
  leak      none of the prompt's internal markers, no API-key-like string

Known limit (accepted 2026-10-19, docs/METHOD.md §11): a place name or a quantity written as a WORD in Devanagari
("दिल्ली", "आधा") cannot be detected here. The English segment the translation must mirror has been checked.
Nothing here logs or returns chat text — only a reason code.
"""

from __future__ import annotations

import re
from typing import Any

Lang = str   # "en" | "hi" | "hinglish"

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_DEV_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
_NUM = re.compile(r"(?<![\w.])[+\-−]?\d+(?:[.,]\d+)*")
_LATIN_CAP = re.compile(r"(?<![\w'-])[A-Z][A-Za-z'-]*")
_LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z'-]*")

# Common Hindi words written in Latin letters (Hinglish). Used to recognise a Hinglish question and so that a capitalised
# Hinglish word at the start of a sentence ("Yeh", "Isse") is not mistaken for an added name.
HINGLISH_WORDS = frozenset("""
kya kyaa hai hain ho hota hoti hote tha thi the kaise kaisa kaisi kyun kyon kab kahan kaun kitna kitni kitne mein main
aur ya nahi nahin na yeh ye yah woh wo vo ka ki ke ko se par pe tak bhi toh to jab agar lekin magar kyunki isliye
batao bataiye batayiye samjhao samjhaiye matlab yaani yani karta karti karte kar sakta sakti sakte raha rahi rahe
iska iski iske isse ismein isme iss is us uska uski uske usse unka unki unke unhe jaise jaisa jaisi jo jis jisse
haan ji dekhiye dekho dekhte samjhiye basically ek do teen sabse zyada jyada kam bahut accha achha sirf hamesha kabhi
phir fir aap aapko aapke hum humein hamare tum apne apna apni wala wali wale liye saath bina hota hua hui hue
chahiye milta milti milte dikhta dikhti dikhte jaata jaati jaate hoga hogi honge
""".split())
# Technical words the translation may capitalise even if the English segment spells them differently.
_ALLOWED_CAPS = frozenset("terratrace ndvi ndbi mndwi nbr evi lst uhi lulc nir swir landsat sentinel google dynamic world "
                          "esa nasa usgs ai hansen copernicus modis".split())

DECLINE: dict[Lang, str] = {
    "en": ("I can only help with forests, satellite Earth observation, land use and land cover (LULC), NDVI, NDBI, land "
           "surface temperature (LST), urban heat islands (UHI) and TerraTrace. Try asking how satellites see forests, or "
           "what TerraTrace measured for the area you are looking at."),
    "hi": ("यह चैट केवल जंगलों, उपग्रह से पृथ्वी के अवलोकन, भूमि उपयोग और भूमि आवरण (LULC), NDVI, NDBI, भूमि सतह तापमान "
           "(LST), शहरी ऊष्मा द्वीप (UHI) और TerraTrace से जुड़े सवालों के जवाब देती है। आप पूछ सकते हैं कि उपग्रह जंगलों को "
           "कैसे देखते हैं।"),
    "hinglish": ("Yeh chat sirf forests, satellite Earth observation, land use aur land cover (LULC), NDVI, NDBI, land "
                 "surface temperature (LST), urban heat island (UHI) aur TerraTrace se jude sawaalon ke jawab deti hai. "
                 "Aap pooch sakte hain ki satellites forests ko kaise dekhte hain."),
}
DROPPED_NOTE: dict[Lang, str] = {
    "hi": "अनुवाद नहीं दिखाया गया: उसकी जाँच नहीं हो सकी। नीचे जाँचा हुआ अंग्रेज़ी उत्तर है।",
    "hinglish": "Translation nahi dikhaya gaya: uski jaanch nahi ho saki. Neeche jaancha hua English jawab hai.",
}


# Hinglish words that are also common English words: never counted as evidence of Hinglish ("What is NDVI?").
_ENGLISH_HOMOGRAPHS = frozenset("is us to do the main par pe ho na so hue ji tum".split())


def detect(text: str) -> Lang:
    """The user's language, decided deterministically from their own words (never from the model)."""
    if DEVANAGARI.search(text):
        return "hi"
    words = re.findall(r"[a-z]+", text.lower())
    hits = sum(w in HINGLISH_WORDS and w not in _ENGLISH_HOMOGRAPHS for w in words)
    if words and hits >= 2 and hits / len(words) >= 0.2:
        return "hinglish"
    return "en"


def numbers(text: str) -> list[float]:
    """Every number in the text as a sorted list (Devanagari digits normalised; thousands separators removed)."""
    out = []
    for m in _NUM.finditer(text.translate(_DEV_DIGITS)):
        s = m.group(0).replace("−", "-")
        s = s.replace(",", "") if re.fullmatch(r"[+\-]?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?", s) else s.replace(",", ".")
        try:
            out.append(round(float(s), 6))
        except ValueError:
            continue
    return sorted(out)


def _stem(w: str) -> str:
    w = w.lower().strip("'-")
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


# Hinglish words that follow a place name ("Delhi mein", "Noida ka", "India se").
_PLACE_PARTICLES = frozenset("mein me ka ki ke ko se par pe tak wala wali wale jaisa jaise".split())
_SENTENCES = re.compile(r"(?<=[.!?।])\s+")
_TOKEN = re.compile(r"[A-Za-z][A-Za-z'-]*")


def added_names(english: str, local: str) -> list[str]:
    """Capitalised Latin-script words in the translation that may be names the English segment does not contain.

    Inside a sentence every such capitalised word counts (Hinglish writes Hindi words in lower case). At the START of a
    sentence Hinglish capitalises ordinary Hindi words ("Sehatmand paudhe…"), so a first word counts only when it is
    used like a place — followed by a place particle ("Delhi mein") or by another capitalised word ("Greater Noida") —
    and is not an ordinary English word. Known limit: a sentence-initial place name with neither is not detected."""
    from .validator import english_vocabulary
    known = {_stem(w) for w in _LATIN_WORD.findall(english)}
    vocab = english_vocabulary()
    out = []
    for sentence in _SENTENCES.split(local):
        toks = _TOKEN.findall(sentence)
        for i, w in enumerate(toks):
            lw = w.lower()
            if not w[0].isupper() or _stem(w) in known or lw in HINGLISH_WORDS or lw in _ALLOWED_CAPS:
                continue
            if i == 0 and sentence.lstrip(" \"'(").startswith(w):
                nxt = toks[1] if len(toks) > 1 else ""
                if lw in vocab or not (nxt[:1].isupper() or nxt.lower() in _PLACE_PARTICLES):
                    continue
            out.append(w)
    return out


def check_segment(english: str, local: Any, lang: Lang, leak_markers: tuple[str, ...]) -> str | None:
    """None if the translation may be shown, else a reason code (never any text)."""
    if not isinstance(local, str) or not local.strip():
        return "missing"
    if any(m and m.lower() in local.lower() for m in leak_markers) or "AIza" in local:
        return "leak"
    if len(local) > 3 * len(english) + 150:
        return "length"
    has_dev = bool(DEVANAGARI.search(local))
    if (lang == "hi" and not has_dev) or (lang == "hinglish" and has_dev):
        return "script"
    if numbers(local) != numbers(english):
        return "numbers"
    if added_names(english, local):
        return "names"
    return None


def check(segments: list[dict[str, Any]], lang: Lang, leak_markers: tuple[str, ...]) -> str | None:
    """None if every segment's translation may be shown; else the first failing reason code."""
    for s in segments:
        r = check_segment(s["text"], s.get("text_local"), lang, leak_markers)
        if r:
            return r
    return None
