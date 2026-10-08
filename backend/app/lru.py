"""Bounded in-memory caches.

The process keeps measured results in memory only as a speed-up: every cache here is backed by the JSON files in
backend/.cache (method-versioned) or can be rebuilt from the same real inputs, so evicting an entry never loses a
result — it is simply read or rebuilt again. Bounding them keeps a long-running server from growing without limit.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Iterator


class LRUDict:
    """Thread-safe dict with least-recently-used eviction once `maxsize` entries are stored."""

    def __init__(self, maxsize: int):
        if maxsize < 1:
            raise ValueError("maxsize must be >= 1")
        self.maxsize = maxsize
        self._d: OrderedDict[Any, Any] = OrderedDict()
        self._lock = threading.Lock()

    def __setitem__(self, key: Any, value: Any) -> None:
        with self._lock:
            self._d[key] = value
            self._d.move_to_end(key)
            while len(self._d) > self.maxsize:
                self._d.popitem(last=False)

    def __getitem__(self, key: Any) -> Any:
        with self._lock:
            value = self._d[key]
            self._d.move_to_end(key)
            return value

    def get(self, key: Any, default: Any = None) -> Any:
        with self._lock:
            if key not in self._d:
                return default
            self._d.move_to_end(key)
            return self._d[key]

    def pop(self, key: Any, default: Any = None) -> Any:
        with self._lock:
            return self._d.pop(key, default)

    def __contains__(self, key: Any) -> bool:
        with self._lock:
            return key in self._d

    def __len__(self) -> int:
        with self._lock:
            return len(self._d)

    def __iter__(self) -> Iterator[Any]:
        with self._lock:
            return iter(list(self._d))

    def items(self) -> list[tuple[Any, Any]]:
        with self._lock:
            return list(self._d.items())

    def values(self) -> list[Any]:
        with self._lock:
            return list(self._d.values())

    def clear(self) -> None:
        with self._lock:
            self._d.clear()
