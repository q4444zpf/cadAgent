from __future__ import annotations

import math
from collections import Counter
from pathlib import Path
from typing import Any

import ezdxf

MAX_EXPAND_DEPTH = 5
MAX_TEXT_SAMPLES = 300
MAX_TEXT_SAMPLE_LENGTH = 200


def parse_dxf(path: str, summary: bool = False) -> dict[str, Any]:
    file_path = Path(path)
    if file_path.suffix.lower() == ".dwg":
        raise ValueError("DWG 文件需先经 ODA File Converter 转换为 DXF")
    if file_path.suffix.lower() != ".dxf":
        raise ValueError(f"不支持的文件格式: {file_path.suffix}")
    if not file_path.is_file():
        raise FileNotFoundError(f"图纸不存在: {path}")

    try:
        doc = ezdxf.readfile(str(file_path))
    except (IOError, ezdxf.DXFStructureError) as error:
        raise ValueError(f"无法解析 DXF 文件：{error}") from error
    if summary:
        return _summarize_drawing(doc, file_path)
    modelspace = doc.modelspace()

    layer_counts: Counter[str] = Counter()
    unsupported: Counter[str] = Counter()
    entities: list[dict[str, Any]] = []

    for entity in modelspace:
        layer_counts[entity.dxf.layer] += 1
        entities.extend(
            _convert_entity(
                entity,
                inherited_layer=entity.dxf.layer,
                handle=entity.dxf.handle,
                depth=0,
                unsupported=unsupported,
            )
        )

    layers = [
        {
            "name": layer.dxf.name,
            "color": int(layer.dxf.color),
            "entityCount": layer_counts.get(layer.dxf.name, 0),
        }
        for layer in doc.layers
    ]
    layers.sort(key=lambda item: item["name"])

    return {
        "path": str(file_path.resolve()),
        "name": file_path.name,
        "layers": layers,
        "entities": entities,
        "bounds": _compute_bounds(entities),
        "unsupported": dict(sorted(unsupported.items())),
    }


def _summarize_drawing(doc: Any, file_path: Path) -> dict[str, Any]:
    type_counts: Counter[str] = Counter()
    layer_counts: Counter[str] = Counter()
    text_samples: list[str] = []
    seen_text: set[str] = set()

    for entity in doc.modelspace():
        dxftype = entity.dxftype()
        type_counts[dxftype] += 1
        layer_counts[entity.dxf.layer] += 1
        if dxftype in {"TEXT", "MTEXT"} and len(text_samples) < MAX_TEXT_SAMPLES:
            text = _entity_text(entity, dxftype).strip()
            if text and text not in seen_text:
                seen_text.add(text)
                text_samples.append(text[:MAX_TEXT_SAMPLE_LENGTH])

    layers = [
        {
            "name": layer.dxf.name,
            "color": int(layer.dxf.color),
            "entityCount": layer_counts.get(layer.dxf.name, 0),
        }
        for layer in doc.layers
    ]
    layers.sort(key=lambda item: item["name"])

    return {
        "path": str(file_path.resolve()),
        "name": file_path.name,
        "layers": layers,
        "entities": [],
        "bounds": _header_bounds(doc),
        "unsupported": {},
        "summaryOnly": True,
        "entityCounts": dict(type_counts.most_common()),
        "textSamples": text_samples,
    }


def _entity_text(entity: Any, dxftype: str) -> str:
    try:
        return entity.plain_text() if dxftype == "MTEXT" else str(entity.dxf.text)
    except Exception:
        return ""


def _header_bounds(doc: Any) -> dict[str, float] | None:
    try:
        low = doc.header.get("$EXTMIN")
        high = doc.header.get("$EXTMAX")
    except Exception:
        return None
    if low is None or high is None:
        return None
    values = [float(low[0]), float(low[1]), float(high[0]), float(high[1])]
    if not all(math.isfinite(value) for value in values):
        return None
    min_x, min_y, max_x, max_y = values
    if max_x <= min_x and max_y <= min_y:
        return None
    return {
        "minX": round(min_x, 6),
        "minY": round(min_y, 6),
        "maxX": round(max_x, 6),
        "maxY": round(max_y, 6),
    }


def _convert_entity(
    entity: Any,
    inherited_layer: str,
    handle: str,
    depth: int,
    unsupported: Counter[str],
) -> list[dict[str, Any]]:
    dxftype = entity.dxftype()
    layer = _resolve_layer(entity, inherited_layer)
    color = int(entity.dxf.get("color", 256))

    if dxftype == "LINE":
        return [
            {
                "kind": "line",
                "handle": handle,
                "layer": layer,
                "color": color,
                "start": _xy(entity.dxf.start),
                "end": _xy(entity.dxf.end),
            }
        ]

    if dxftype in {"LWPOLYLINE", "POLYLINE"}:
        primitive = _polyline(entity, dxftype, layer, color, handle)
        return [primitive] if primitive else []

    if dxftype == "CIRCLE":
        return [
            {
                "kind": "circle",
                "handle": handle,
                "layer": layer,
                "color": color,
                "center": _xy(entity.dxf.center),
                "radius": round(float(entity.dxf.radius), 6),
            }
        ]

    if dxftype == "ARC":
        return [
            {
                "kind": "arc",
                "handle": handle,
                "layer": layer,
                "color": color,
                "center": _xy(entity.dxf.center),
                "radius": round(float(entity.dxf.radius), 6),
                "startAngle": round(float(entity.dxf.start_angle), 6),
                "endAngle": round(float(entity.dxf.end_angle), 6),
            }
        ]

    if dxftype in {"TEXT", "MTEXT"}:
        return [_text(entity, dxftype, layer, color, handle)]

    if dxftype in {"INSERT", "DIMENSION"}:
        if depth >= MAX_EXPAND_DEPTH:
            unsupported[dxftype] += 1
            return []
        try:
            virtuals = list(entity.virtual_entities())
        except Exception:
            unsupported[dxftype] += 1
            return []
        expanded: list[dict[str, Any]] = []
        for virtual in virtuals:
            expanded.extend(
                _convert_entity(
                    virtual,
                    inherited_layer=layer,
                    handle=handle,
                    depth=depth + 1,
                    unsupported=unsupported,
                )
            )
        return expanded

    unsupported[dxftype] += 1
    return []


def _polyline(
    entity: Any, dxftype: str, layer: str, color: int, handle: str
) -> dict[str, Any] | None:
    if dxftype == "LWPOLYLINE":
        points = [[round(float(x), 6), round(float(y), 6)] for x, y in entity.get_points("xy")]
        closed = bool(entity.closed)
    else:
        points = [_xy(vertex) for vertex in entity.points()]
        closed = bool(entity.is_closed)

    if len(points) < 2:
        return None

    return {
        "kind": "polyline",
        "handle": handle,
        "layer": layer,
        "color": color,
        "points": points,
        "closed": closed,
    }


def _text(entity: Any, dxftype: str, layer: str, color: int, handle: str) -> dict[str, Any]:
    if dxftype == "MTEXT":
        text = entity.plain_text()
        height = float(entity.dxf.char_height)
    else:
        text = entity.dxf.text
        height = float(entity.dxf.height)

    return {
        "kind": "text",
        "handle": handle,
        "layer": layer,
        "color": color,
        "insert": _xy(entity.dxf.insert),
        "text": text,
        "height": round(height, 6),
        "rotation": round(float(entity.dxf.get("rotation", 0)), 6),
    }


def _resolve_layer(entity: Any, inherited_layer: str) -> str:
    layer = entity.dxf.get("layer", "0")
    if layer == "0" and inherited_layer not in {"", "0"}:
        return inherited_layer
    return layer


def _xy(vector: Any) -> list[float]:
    return [round(float(vector.x), 6), round(float(vector.y), 6)]


def _compute_bounds(entities: list[dict[str, Any]]) -> dict[str, float] | None:
    xs: list[float] = []
    ys: list[float] = []

    for entity in entities:
        kind = entity["kind"]
        if kind == "line":
            xs.extend([entity["start"][0], entity["end"][0]])
            ys.extend([entity["start"][1], entity["end"][1]])
        elif kind == "polyline":
            for point in entity["points"]:
                xs.append(point[0])
                ys.append(point[1])
        elif kind in {"circle", "arc"}:
            center = entity["center"]
            radius = entity["radius"]
            xs.extend([center[0] - radius, center[0] + radius])
            ys.extend([center[1] - radius, center[1] + radius])
        elif kind == "text":
            x, y = entity["insert"]
            height = entity["height"]
            xs.extend([x, x + len(entity["text"]) * height * 0.6])
            ys.extend([y, y + height])

    if not xs or not ys:
        return None

    return {
        "minX": round(min(xs), 6),
        "minY": round(min(ys), 6),
        "maxX": round(max(xs), 6),
        "maxY": round(max(ys), 6),
    }
