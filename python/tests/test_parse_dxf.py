from __future__ import annotations

from pathlib import Path

import ezdxf
import pytest

from cad_service.drawing import parse_dxf
from cad_service.service import handle_request


def _make_simple(path: Path) -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("WALLS", color=1)
    doc.layers.add("SYMBOL", color=3)
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0), dxfattribs={"layer": "WALLS"})
    msp.add_line((0, 0), (0, 50), dxfattribs={"layer": "WALLS"})
    msp.add_circle((50, 25), 10, dxfattribs={"layer": "SYMBOL"})
    msp.add_text("TEST", dxfattribs={"layer": "SYMBOL", "height": 5}).set_placement((10, 30))
    doc.saveas(path)


def _make_block(path: Path) -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("BLOCK", color=2)
    block = doc.blocks.new(name="SYM")
    block.add_line((0, 0), (1, 0))
    block.add_circle((0, 0), 1)
    doc.modelspace().add_blockref("SYM", (10, 20), dxfattribs={"layer": "BLOCK"})
    doc.saveas(path)


def _make_dimension(path: Path) -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("DIM", color=4)
    msp = doc.modelspace()
    dim = msp.add_linear_dim(base=(0, 10), p1=(0, 0), p2=(100, 0), dxfattribs={"layer": "DIM"})
    dim.render()
    doc.saveas(path)


def test_parse_simple_drawing_reports_layers_entities_and_bounds(tmp_path: Path) -> None:
    path = tmp_path / "simple.dxf"
    _make_simple(path)

    drawing = parse_dxf(str(path))

    assert drawing["name"] == "simple.dxf"
    layers = {layer["name"]: layer for layer in drawing["layers"]}
    assert layers["WALLS"]["entityCount"] == 2
    assert layers["SYMBOL"]["entityCount"] == 2

    kinds = [entity["kind"] for entity in drawing["entities"]]
    assert kinds.count("line") == 2
    assert kinds.count("circle") == 1
    assert kinds.count("text") == 1

    assert drawing["bounds"] == {"minX": 0.0, "minY": 0.0, "maxX": 100.0, "maxY": 50.0}


def test_parse_expands_block_references_in_place(tmp_path: Path) -> None:
    path = tmp_path / "block.dxf"
    _make_block(path)

    drawing = parse_dxf(str(path))

    layers = {layer["name"]: layer for layer in drawing["layers"]}
    assert layers["BLOCK"]["entityCount"] == 1

    kinds = sorted(entity["kind"] for entity in drawing["entities"])
    assert kinds == ["circle", "line"]

    line = next(entity for entity in drawing["entities"] if entity["kind"] == "line")
    circle = next(entity for entity in drawing["entities"] if entity["kind"] == "circle")
    assert line["layer"] == "BLOCK"
    assert line["start"] == [10.0, 20.0]
    assert line["end"] == [11.0, 20.0]
    assert circle["center"] == [10.0, 20.0]


def test_parse_expands_dimensions_on_their_layer(tmp_path: Path) -> None:
    path = tmp_path / "dim.dxf"
    _make_dimension(path)

    drawing = parse_dxf(str(path))

    assert len(drawing["entities"]) > 2
    assert {entity["layer"] for entity in drawing["entities"]} == {"DIM"}


def test_summary_mode_counts_entities_without_expanding_them(tmp_path: Path) -> None:
    path = tmp_path / "simple.dxf"
    _make_simple(path)

    drawing = parse_dxf(str(path), summary=True)

    assert drawing["summaryOnly"] is True
    assert drawing["entities"] == []
    assert drawing["entityCounts"] == {"LINE": 2, "CIRCLE": 1, "TEXT": 1}
    assert drawing["textSamples"] == ["TEST"]
    layers = {layer["name"]: layer for layer in drawing["layers"]}
    assert layers["WALLS"]["entityCount"] == 2


def test_summary_mode_keeps_blocks_unexpanded(tmp_path: Path) -> None:
    path = tmp_path / "block.dxf"
    _make_block(path)

    drawing = parse_dxf(str(path), summary=True)

    assert drawing["entityCounts"] == {"INSERT": 1}
    layers = {layer["name"]: layer for layer in drawing["layers"]}
    assert layers["BLOCK"]["entityCount"] == 1


def test_service_dispatches_summary_requests(tmp_path: Path) -> None:
    path = tmp_path / "simple.dxf"
    _make_simple(path)

    response = handle_request(
        {"id": "2", "method": "parse_dxf", "params": {"path": str(path), "summary": True}}
    )

    assert response["ok"] is True
    assert response["result"]["summaryOnly"] is True
    assert response["result"]["entities"] == []


def test_parse_rejects_invalid_file_and_service_reports_error(tmp_path: Path) -> None:
    path = tmp_path / "bad.dxf"
    path.write_text("this is not a dxf", encoding="utf-8")

    with pytest.raises(ValueError, match="无法解析 DXF 文件"):
        parse_dxf(str(path))

    response = handle_request({"id": "1", "method": "parse_dxf", "params": {"path": str(path)}})
    assert response["id"] == "1"
    assert response["ok"] is False
    assert response["error"]["code"] == "handler_error"
    assert "无法解析 DXF 文件" in response["error"]["message"]
