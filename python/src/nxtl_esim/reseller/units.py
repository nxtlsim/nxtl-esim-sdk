"""SI data units. 1 MB = 1000**2 bytes, 1 GB = 1000**3 bytes."""

from __future__ import annotations

_SI = {"B": 1, "KB": 1000, "MB": 1_000_000, "GB": 1_000_000_000, "TB": 1_000_000_000_000}


def to_bytes(value: float, unit: str) -> float:
    if value < 0:
        raise TypeError("data amount must be a finite number >= 0")
    factor = _SI.get(unit)
    if factor is None:
        raise TypeError(f"Unknown data unit {unit}")
    return float(value) * factor


def from_bytes(num_bytes: float) -> dict[str, float]:
    if num_bytes < 0:
        raise TypeError("bytes must be a finite number >= 0")
    return {
        "bytes": num_bytes,
        "kb": num_bytes / _SI["KB"],
        "mb": num_bytes / _SI["MB"],
        "gb": num_bytes / _SI["GB"],
    }


def format_data(num_bytes: float, unit: str = "GB") -> str:
    volume = from_bytes(num_bytes)
    value = {
        "B": volume["bytes"],
        "KB": volume["kb"],
        "MB": volume["mb"],
        "GB": volume["gb"],
        "TB": num_bytes / _SI["TB"],
    }[unit]
    digits = 0 if unit == "B" else 2
    return f"{value:.{digits}f} {unit}"
