from __future__ import annotations

from pathlib import Path

import ezdxf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "samples" / "fixtures"


def make_simple() -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("WALLS", color=1)
    doc.layers.add("SYMBOL", color=3)
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0), dxfattribs={"layer": "WALLS"})
    msp.add_line((0, 0), (0, 50), dxfattribs={"layer": "WALLS"})
    msp.add_circle((50, 25), 10, dxfattribs={"layer": "SYMBOL"})
    msp.add_text("TEST", dxfattribs={"layer": "SYMBOL", "height": 5}).set_placement((10, 30))
    doc.saveas(OUT / "simple.dxf")


def make_block() -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("BLOCK", color=2)
    block = doc.blocks.new(name="SYM")
    block.add_line((0, 0), (1, 0))
    block.add_circle((0, 0), 1)
    doc.modelspace().add_blockref("SYM", (10, 20), dxfattribs={"layer": "BLOCK"})
    doc.saveas(OUT / "block.dxf")


def make_dimension() -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("DIM", color=4)
    msp = doc.modelspace()
    dim = msp.add_linear_dim(base=(0, 10), p1=(0, 0), p2=(100, 0), dxfattribs={"layer": "DIM"})
    dim.render()
    doc.saveas(OUT / "dim.dxf")


def make_broken_fixtures() -> None:
    (OUT / "broken.dxf").write_text("这不是一个有效的 DXF 文件\n", encoding="utf-8")
    (OUT / "placeholder.dwg").write_text("DWG 占位文件：仅用于验证导入提示\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    make_simple()
    make_block()
    make_dimension()
    make_broken_fixtures()
    print(f"fixtures written to {OUT}")


if __name__ == "__main__":
    main()
