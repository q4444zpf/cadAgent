from __future__ import annotations

import io
import os
import tarfile
import zipfile
from pathlib import Path

import ezdxf
import pytest

from cad_service.service import handle_request


def _zip(path: Path, entries: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)


def _tar_gz(path: Path, entries: dict[str, bytes]) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))


def _call(method: str, params: dict) -> dict:
    return handle_request({"id": "req", "method": method, "params": params})


def test_project_scan_aggregates_files_by_extension(tmp_path: Path) -> None:
    (tmp_path / "图纸").mkdir()
    (tmp_path / "图纸" / "a.dxf").write_bytes(b"a")
    (tmp_path / "图纸" / "b.DXF").write_bytes(b"b")
    (tmp_path / "说明.pdf").write_bytes(b"pdf")
    _zip(tmp_path / "归档.zip", {"x.txt": b"x"})
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_bytes(b"ignored")

    response = _call("project_scan", {"root": str(tmp_path)})

    assert response["ok"] is True
    result = response["result"]
    assert result["totals"] == {"files": 4, "dirs": 1, "archives": 1}
    assert result["byExtension"] == {"dxf": 2, "pdf": 1, "zip": 1}
    assert result["ignored"] == [
        ".git",
        ".pytest_cache",
        ".venv",
        ".vscode",
        ".idea",
        "__pycache__",
        "node_modules",
    ]
    names = {entry["name"]: entry for entry in result["entries"]}
    assert names["图纸"]["type"] == "dir"
    assert names["归档.zip"]["type"] == "archive"
    assert names["说明.pdf"]["extension"] == "pdf"
    assert ".git" not in names


def test_project_scan_filters_entries_and_extensions(tmp_path: Path) -> None:
    (tmp_path / "图纸").mkdir()
    (tmp_path / "图纸" / "a.dxf").write_bytes(b"a")
    (tmp_path / "图纸" / "说明.txt").write_bytes(b"t")

    response = _call(
        "project_scan",
        {"root": str(tmp_path), "path": "图纸", "extension": "dxf"},
    )

    result = response["result"]
    assert [entry["name"] for entry in result["entries"]] == ["a.dxf"]
    assert result["byExtension"] == {"dxf": 1}
    assert result["totals"] == {"files": 1, "dirs": 0, "archives": 0}


def test_project_scan_rejects_paths_outside_the_project(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("secret", encoding="utf-8")

    response = _call(
        "project_scan",
        {"root": str(project), "path": "../outside.txt"},
    )

    assert response["ok"] is False
    assert "超出项目范围" in response["error"]["message"]


def test_project_scan_does_not_follow_directory_symlinks(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    target = tmp_path / "target"
    target.mkdir()
    (target / "secret.dxf").write_bytes(b"x")
    link = project / "linked"
    try:
        os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("当前环境无法创建目录符号链接")

    response = _call("project_scan", {"root": str(project)})

    assert response["ok"] is True
    entries = {entry["name"]: entry for entry in response["result"]["entries"]}
    assert entries["linked"]["type"] == "symlink"
    assert response["result"]["totals"]["files"] == 0


def test_archive_list_reads_zip_and_tar_members(tmp_path: Path) -> None:
    _zip(tmp_path / "a.zip", {"图纸/a.dxf": b"dxf", "说明.txt": b"text"})
    _tar_gz(tmp_path / "b.tar.gz", {"图纸/a.dxf": b"dxf"})

    zipped = _call("archive_list", {"root": str(tmp_path), "path": "a.zip"})
    tarred = _call("archive_list", {"root": str(tmp_path), "path": "b.tar.gz"})

    assert zipped["ok"] is True
    assert zipped["result"]["format"] == "zip"
    assert zipped["result"]["entryCount"] == 2
    assert zipped["result"]["totalUncompressedBytes"] == 7
    assert [entry["name"] for entry in zipped["result"]["entries"]] == [
        "图纸/a.dxf",
        "说明.txt",
    ]

    assert tarred["ok"] is True
    assert tarred["result"]["format"] == "tar.gz"
    assert [entry["name"] for entry in tarred["result"]["entries"]] == ["图纸/a.dxf"]


def test_archive_list_rejects_unsupported_formats(tmp_path: Path) -> None:
    (tmp_path / "a.rar").write_bytes(b"rar")

    response = _call("archive_list", {"root": str(tmp_path), "path": "a.rar"})

    assert response["ok"] is False
    assert "暂不支持" in response["error"]["message"]


def test_archive_extract_creates_sibling_directory_without_overwrite(
    tmp_path: Path,
) -> None:
    _zip(tmp_path / "资料.zip", {"图纸/a.dxf": b"dxf", "说明.txt": b"text"})

    first = _call("archive_extract", {"root": str(tmp_path), "path": "资料.zip"})
    second = _call("archive_extract", {"root": str(tmp_path), "path": "资料.zip"})

    assert first["ok"] is True
    assert first["result"]["target"] == "资料_解压"
    assert first["result"]["filesExtracted"] == 2
    assert (tmp_path / "资料_解压" / "图纸" / "a.dxf").read_bytes() == b"dxf"
    assert (tmp_path / "资料_解压" / "说明.txt").read_bytes() == b"text"

    assert second["result"]["target"] == "资料_解压-2"
    assert (tmp_path / "资料_解压-2" / "说明.txt").exists()


def test_archive_extract_honours_an_explicit_target_inside_the_project(
    tmp_path: Path,
) -> None:
    _zip(tmp_path / "a.zip", {"a.txt": b"a"})
    (tmp_path / "输出").mkdir()

    response = _call(
        "archive_extract",
        {"root": str(tmp_path), "path": "a.zip", "target": "输出/结果"},
    )

    assert response["ok"] is True
    assert response["result"]["target"] == "输出/结果"
    assert (tmp_path / "输出" / "结果" / "a.txt").read_bytes() == b"a"


def test_archive_extract_rejects_traversal_members(tmp_path: Path) -> None:
    _zip(tmp_path / "evil.zip", {"../evil.txt": b"evil", "ok.txt": b"ok"})

    response = _call("archive_extract", {"root": str(tmp_path), "path": "evil.zip"})

    assert response["ok"] is False
    assert "压缩包成员" in response["error"]["message"]
    assert not (tmp_path / "evil_解压").exists()
    assert not (tmp_path.parent / "evil.txt").exists()


def test_archive_extract_rejects_symlink_members(tmp_path: Path) -> None:
    with tarfile.open(tmp_path / "link.tar", "w") as archive:
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        archive.addfile(info)

    response = _call("archive_extract", {"root": str(tmp_path), "path": "link.tar"})

    assert response["ok"] is False
    assert "链接" in response["error"]["message"]
    assert not (tmp_path / "link_解压").exists()


def test_archive_extract_refuses_an_existing_explicit_target(tmp_path: Path) -> None:
    _zip(tmp_path / "a.zip", {"a.txt": b"a"})
    target = tmp_path / "已存在"
    target.mkdir()
    (target / "keep.txt").write_text("keep", encoding="utf-8")

    response = _call(
        "archive_extract",
        {"root": str(tmp_path), "path": "a.zip", "target": "已存在"},
    )

    assert response["ok"] is False
    assert "目标目录已存在" in response["error"]["message"]
    assert (target / "keep.txt").read_text(encoding="utf-8") == "keep"
    assert not (target / "a.txt").exists()


def test_archive_extract_enforces_entry_limits(tmp_path: Path, monkeypatch) -> None:
    from cad_service import files

    monkeypatch.setattr(files, "MAX_ARCHIVE_ENTRIES", 2)
    _zip(tmp_path / "many.zip", {"a.txt": b"a", "b.txt": b"b", "c.txt": b"c"})

    response = _call("archive_extract", {"root": str(tmp_path), "path": "many.zip"})

    assert response["ok"] is False
    assert "条目数" in response["error"]["message"]
    assert not (tmp_path / "many_解压").exists()


def test_read_file_decodes_utf8_and_gb18030(tmp_path: Path) -> None:
    (tmp_path / "utf8.txt").write_text("净宽 600", encoding="utf-8")
    (tmp_path / "bom.txt").write_text("净宽 600", encoding="utf-8-sig")
    (tmp_path / "gbk.txt").write_bytes("纵坡 0.3%".encode("gb18030"))

    utf8 = _call("read_file", {"root": str(tmp_path), "path": "utf8.txt"})
    bom = _call("read_file", {"root": str(tmp_path), "path": "bom.txt"})
    gbk = _call("read_file", {"root": str(tmp_path), "path": "gbk.txt"})

    assert utf8["result"]["kind"] == "text"
    assert utf8["result"]["content"] == "净宽 600"
    assert utf8["result"]["encoding"] == "utf-8"
    assert bom["result"]["content"] == "净宽 600"
    assert bom["result"]["encoding"] == "utf-8-sig"
    assert gbk["result"]["content"] == "纵坡 0.3%"
    assert gbk["result"]["encoding"] == "gb18030"


def test_read_file_truncates_long_text(tmp_path: Path) -> None:
    (tmp_path / "long.txt").write_text("abcdef", encoding="utf-8")

    response = _call("read_file", {"root": str(tmp_path), "path": "long.txt", "maxChars": 3})

    assert response["result"]["content"] == "abc"
    assert response["result"]["truncated"] is True


def test_read_file_rejects_secrets_and_path_escape(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("API_KEY=1", encoding="utf-8")
    (tmp_path / "server.pem").write_text("secret", encoding="utf-8")
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("secret", encoding="utf-8")

    secret = _call("read_file", {"root": str(tmp_path), "path": ".env"})
    pem = _call("read_file", {"root": str(tmp_path), "path": "server.pem"})
    escaped = _call("read_file", {"root": str(tmp_path), "path": "../outside.txt"})

    assert secret["ok"] is False
    assert "敏感" in secret["error"]["message"]
    assert pem["ok"] is False
    assert "敏感" in pem["error"]["message"]
    assert escaped["ok"] is False
    assert "超出项目范围" in escaped["error"]["message"]


def test_read_file_returns_dxf_summary(tmp_path: Path) -> None:
    doc = ezdxf.new("R2010")
    doc.layers.add("WALLS", color=1)
    doc.modelspace().add_line((0, 0), (10, 0), dxfattribs={"layer": "WALLS"})
    doc.saveas(tmp_path / "a.dxf")

    response = _call("read_file", {"root": str(tmp_path), "path": "a.dxf"})

    assert response["result"]["kind"] == "dxf"
    assert response["result"]["summary"]["summaryOnly"] is True
    layers = {layer["name"]: layer for layer in response["result"]["summary"]["layers"]}
    assert layers["WALLS"]["entityCount"] == 1


def test_read_file_returns_docx_text(tmp_path: Path) -> None:
    from docx import Document

    document = Document()
    document.add_paragraph("设计净宽 600mm")
    document.save(tmp_path / "说明.docx")

    response = _call("read_file", {"root": str(tmp_path), "path": "说明.docx"})

    assert response["result"]["kind"] == "docx"
    assert "设计净宽 600mm" in response["result"]["content"]


def test_service_rejects_missing_project_root(tmp_path: Path) -> None:
    response = _call("project_scan", {"root": str(tmp_path / "missing")})

    assert response["ok"] is False
    assert "项目根目录" in response["error"]["message"]
