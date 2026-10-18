"""Random Forest LULC classification in Earth Engine: sampling, 70/30 split, training, accuracy.

Flow per study year:
  1. Count the reference-label pixels available per class (reported, so a thin class is visible).
  2. Draw a stratified random sample (equal number of points per class) of label + 12 features at 30 m.
  3. Split it 70/30 per class with a fixed seed — done locally so the exact split is saved to CSV.
  4. Train ee.Classifier.smileRandomForest on the 70 %, classify the held-out 30 %, build the confusion matrix.
  5. The trained classifier classifies every pixel of the year's feature image (downloaded later).
"""

from __future__ import annotations

from typing import Any

import ee
import numpy as np
import pandas as pd

from .config import Config
from .landsat import FEATURES


def label_counts(cfg: Config, label, geom) -> dict[int, int]:
    """Number of 30 m reference-label pixels per class inside the study area."""
    hist = label.reduceRegion(ee.Reducer.frequencyHistogram(), geom, crs=cfg.crs, scale=cfg.scale,
                              maxPixels=1e10, tileScale=4).get("label").getInfo() or {}
    counts = {c: 0 for c in cfg.class_codes}
    for k, v in hist.items():
        counts[int(float(k))] = int(round(v))
    return counts


def draw_sample(cfg: Config, features, label, geom, seed: int) -> pd.DataFrame:
    """Stratified random points: up to points_per_class per class, with every feature value at that pixel."""
    n = int(cfg.rf["points_per_class"])
    fc = features.addBands(label).stratifiedSample(
        numPoints=n, classBand="label", region=geom, scale=cfg.scale, projection=ee.Projection(cfg.crs), seed=seed,
        classValues=cfg.class_codes, classPoints=[n] * len(cfg.class_codes), dropNulls=True, tileScale=4, geometries=True)
    rows = []
    for f in fc.getInfo()["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        rows.append({"lon": lon, "lat": lat, "label": int(p["label"]), **{b: p[b] for b in FEATURES}})
    return pd.DataFrame(rows, columns=["lon", "lat", "label", *FEATURES])


def split(df: pd.DataFrame, train_fraction: float, seed: int) -> pd.DataFrame:
    """Adds column `set` = 'train' / 'test': train_fraction of each class to training, the rest held out."""
    rng = np.random.default_rng(seed)
    out = df.copy()
    out["set"] = "test"
    for _, idx in out.groupby("label").groups.items():
        idx = np.array(sorted(idx))
        rng.shuffle(idx)
        out.loc[idx[: int(round(len(idx) * train_fraction))], "set"] = "train"
    return out


def to_fc(df: pd.DataFrame) -> ee.FeatureCollection:
    """Local points → Earth Engine features (so the classifier sees exactly the saved training set)."""
    return ee.FeatureCollection([
        ee.Feature(ee.Geometry.Point([r.lon, r.lat]), {"label": int(r.label), **{b: float(getattr(r, b)) for b in FEATURES}})
        for r in df.itertuples()
    ])


def classifier(cfg: Config, train_df: pd.DataFrame):
    rf = ee.Classifier.smileRandomForest(numberOfTrees=int(cfg.rf["trees"]), seed=int(cfg.rf["seed"]))
    return rf.train(features=to_fc(train_df), classProperty="label", inputProperties=list(FEATURES))


def assess(cfg: Config, clf, test_df: pd.DataFrame) -> dict[str, Any]:
    """Confusion matrix and the usual measures on the held-out 30 % (rows = reference, columns = predicted)."""
    order = cfg.class_codes
    m = to_fc(test_df).classify(clf, "predicted").errorMatrix("label", "predicted", order)
    res = ee.Dictionary({"matrix": m.array(), "importance": ee.Dictionary(clf.explain()).get("importance")}).getInfo()
    # errorMatrix is indexed by class value 0..max; keep rows/cols of our codes only.
    full = np.array(res["matrix"], dtype=float)
    mat = full[np.ix_(order, order)] if full.shape[0] > max(order) else full
    return {"matrix": mat.astype(int).tolist(), **metrics(mat), "importance": res["importance"]}


def metrics(mat: np.ndarray) -> dict[str, Any]:
    """Overall accuracy, Cohen's kappa, producer's / user's accuracy and F1 from a confusion matrix
    (rows = reference, columns = predicted). Pure numpy so it is unit-tested offline."""
    mat = np.asarray(mat, dtype=float)
    n = mat.sum()
    diag = np.diag(mat)
    oa = diag.sum() / n if n else float("nan")
    pe = (mat.sum(0) * mat.sum(1)).sum() / n**2 if n else float("nan")
    kappa = (oa - pe) / (1 - pe) if n and pe != 1 else float("nan")
    with np.errstate(invalid="ignore", divide="ignore"):
        producers = diag / mat.sum(1)
        users = diag / mat.sum(0)
        f1 = 2 * producers * users / (producers + users)
    return {"overall_accuracy": float(oa), "kappa": float(kappa), "n_test": int(n),
            "producers_accuracy": producers.tolist(), "users_accuracy": users.tolist(), "f1": f1.tolist()}
