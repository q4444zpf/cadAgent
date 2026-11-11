from __future__ import annotations

from pathlib import Path

import ezdxf

from cad_service.drawing import close_dxf, layer_entities, open_dxf
from cad_service.service import handle_request


def _make_layered(path: Path) -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("WALLS", color=1)
    doc.layers.add("SYMBOL", color=3)
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0), dxfattribs={"layer": "WALLS"})
    msp.add_line((0, 0), (0, 50), dxfattribs={"layer": "WALLS"})
    msp.add_circle((50, 25), 10, dxfattribs={"layer": "SYMBOL"})
    doc.saveas(path)


def _make_block(path: Path) -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("BLOCK", color=2)
    block = doc.blocks.new(name="SYM")
    block.add_line((0, 0), (1, 0))
    block.add_circle((0, 0), 1)
    doc.modelspace().add_blockref("SYM", (10, 20), dxfattribs={"layer": "BLOCK"})
    doc.saveas(path)


def _spy_readfile(monkeypatch) -> list[str]:
    original = ezdxf.readfile
    calls: list[str] = []

    def spy(path, *args, **kwargs):
        calls.append(str(path))
        return original(path, *args, **kwargs)

    monkeypatch.setattr(ezdxf, "readfile", spy)
    return calls


def test_open_dxf_returns_summary_without_expanding_entities(tmp_path: Path) -> None:
    path = tmp_path / "layered.dxf"
    _make_layered(path)

    summary = open_dxf(str(path))

    assert summary["summaryOnly"] is True
    assert summary["entities"] == []
    layers = {layer["name"]: layer for layer in summary["layers"]}
    assert layers["WALLS"]["entityCount"] == 2
    assert layers["SYMBOL"]["entityCount"] == 1


def test_layer_entities_reuses_the_open_document(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "layered.dxf"
    _make_layered(path)
    calls = _spy_readfile(monkeypatch)

    open_dxf(str(path))
    walls = layer_entities(str(path), "WALLS")
    symbol = layer_entities(str(path), "SYMBOL")

    assert calls == [str(path)]
    assert [entity["kind"] for entity in walls["entities"]] == ["line", "line"]
    assert walls["entities"][0]["layer"] == "WALLS"
    assert [entity["kind"] for entity in symbol["entities"]] == ["circle"]


def test_layer_entities_expands_blocks_on_their_layer(tmp_path: Path) -> None:
    path = tmp_path / "block.dxf"
    _make_block(path)

    open_dxf(str(path))
    result = layer_entities(str(path), "BLOCK")

    assert sorted(entity["kind"] for entity in result["entities"]) == ["circle", "line"]
    assert {entity["layer"] for entity in result["entities"]} == {"BLOCK"}


def test_layer_entities_returns_empty_for_unknown_layer(tmp_path: Path) -> None:
    path = tmp_path / "layered.dxf"
    _make_layered(path)

    open_dxf(str(path))

    assert layer_entities(str(path), "NOPE")["entities"] == []


def test_close_dxf_releases_the_cached_document(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "layered.dxf"
    _make_layered(path)
    calls = _spy_readfile(monkeypatch)

    open_dxf(str(path))
    close_dxf()
    result = layer_entities(str(path), "WALLS")

    assert calls == [str(path), str(path)]
    assert len(result["entities"]) == 2


def test_open_another_drawing_replaces_the_cached_document(
    tmp_path: Path, monkeypatch
) -> None:
    first = tmp_path / "first.dxf"
    second = tmp_path / "second.dxf"
    _make_layered(first)
    _make_block(second)
    calls = _spy_readfile(monkeypatch)

    open_dxf(str(first))
    open_dxf(str(second))
    layer_entities(str(first), "WALLS")

    assert calls == [str(first), str(second), str(first)]


def test_service_dispatches_layer_requests(tmp_path: Path) -> None:
    path = tmp_path / "layered.dxf"
    _make_layered(path)

    opened = handle_request(
        {"id": "1", "method": "open_dxf", "params": {"path": str(path)}}
    )
    layer = handle_request(
        {
            "id": "2",
            "method": "layer_entities",
            "params": {"path": str(path), "layer": "WALLS"},
        }
    )
    closed = handle_request({"id": "3", "method": "close_dxf", "params": {}})

    assert opened["ok"] is True
    assert opened["result"]["summaryOnly"] is True
    assert layer["ok"] is True
    assert len(layer["result"]["entities"]) == 2
    assert closed["ok"] is True


def test_service_rejects_layer_request_without_layer(tmp_path: Path) -> None:
    path = tmp_path / "layered.dxf"
    _make_layered(path)

    response = handle_request(
        {"id": "4", "method": "layer_entities", "params": {"path": str(path)}}
    )

    assert response["ok"] is False
    assert "layer" in response["error"]["message"]
