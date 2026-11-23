"""TerraTrace LULC + Urban Heat Island case-study pipeline (Google Earth Engine + local statistics)."""

__version__ = "1.0.2"

# One line per release; the PDF report prints these at its end.
CHANGELOG = {
    "1.0.2": "2026-11-24 — Surface heat analysis withdrawn pending a weather-normalised method.",
    "1.0.1": "2026-11-21 — reporting fixes only, no result changed (classification, temperatures and tables are the same "
             "Earth Engine run): study area given as the sum of classified pixels; winter composites labelled by both years; "
             "scene-date table and scene-timing check; IMD weather context for 2025; vegetation gross churn and a stable-area check; "
             "reference-label years stated; class renamed \"Built-up and bare land\"; all references cited in the text.",
    "1.0.0": "2026-10-20 — first release: 2015 and 2025 maps, temperatures and report.",
}
