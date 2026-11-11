from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from cad_service.kb import KbStore

FIXTURES = Path(__file__).resolve().parents[2] / "samples" / "kb"

RECOGNITION = {
    "description": "扫描图纸显示排水沟剖面，文字标注：排水沟净宽 600×600，壁厚 100mm。",
    "points": ["排水沟净宽 600mm", "壁厚 100mm"],
    "confidence": 0.55,
}


@pytest.fixture()
def store(tmp_path: Path) -> KbStore:
    return KbStore(tmp_path / "kb")


def import_all(store: KbStore) -> dict[str, dict]:
    docs = {}
    for name in ["spec.pdf", "manual.docx", "notes.dxf", "params.csv"]:
        doc = store.import_document(FIXTURES / name)
        docs[name] = doc
    return docs


def test_imports_all_four_source_types_with_locations(store: KbStore) -> None:
    docs = import_all(store)

    assert {name: doc["status"] for name, doc in docs.items()} == {
        "spec.pdf": "ready",
        "manual.docx": "ready",
        "notes.dxf": "ready",
        "params.csv": "ready",
    }
    assert [doc["type"] for doc in docs.values()] == ["pdf", "docx", "dxf", "csv"]
    assert all(doc["chunkCount"] > 0 for doc in docs.values())
    assert all(doc["name"] == name for name, doc in docs.items())

    locations = {name: doc["chunks"][0]["location"] for name, doc in docs.items()}
    assert locations["spec.pdf"].get("page") == 1
    assert locations["manual.docx"].get("paragraph", 0) >= 1
    assert locations["notes.dxf"].get("handle") == "A1F"
    assert locations["params.csv"].get("row") == 1

    reloaded = KbStore(store.root)
    assert len(reloaded.list_documents()) == 4


def test_failed_import_reports_reason_and_can_be_retried(store: KbStore, tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    shutil.copy(FIXTURES / "broken.pdf", broken)

    failed = store.import_document(broken)
    assert failed["status"] == "failed"
    assert failed["error"]

    shutil.copy(FIXTURES / "spec.pdf", broken)
    retried = store.import_document(broken)
    assert retried["status"] == "ready"
    assert retried["chunkCount"] > 0


def test_search_returns_expected_source_and_location(store: KbStore) -> None:
    import_all(store)

    page_hit = store.search("longitudinal slope 0.3 percent")[0]
    assert page_hit["docName"] == "spec.pdf"
    assert page_hit["location"]["page"] == 1

    chinese_hit = store.search("沟底纵坡 0.3")[0]
    assert chinese_hit["docName"] in {"manual.docx", "params.csv"}
    assert "location" in chinese_hit

    dxf_hit = store.search("排水沟 600 壁厚")[0]
    assert dxf_hit["docName"] == "notes.dxf"
    assert dxf_hit["location"]["handle"] == "A1F"


def test_search_reports_no_hits_instead_of_noise(store: KbStore) -> None:
    import_all(store)

    assert store.search("quantum entanglement") == []


def test_delete_removes_document_from_search(store: KbStore) -> None:
    docs = import_all(store)
    manual = docs["manual.docx"]

    store.delete(manual["id"])

    assert all(doc["name"] != "manual.docx" for doc in store.list_documents())
    for hit in store.search("沟底纵坡 0.3"):
        assert hit["docName"] != "manual.docx"


def test_rebuild_preserves_chunk_counts(store: KbStore) -> None:
    import_all(store)
    expected = sum(doc["chunkCount"] for doc in store.list_documents())

    summary = store.rebuild()

    assert summary["documents"] == 4
    assert summary["failed"] == 0
    assert summary["chunks"] == expected == sum(
        doc["chunkCount"] for doc in store.list_documents()
    )


def test_scan_image_requires_vision_recognition(store: KbStore) -> None:
    failed = store.import_document(FIXTURES / "scan.png")

    assert failed["status"] == "failed"
    assert failed["type"] == "image"
    assert "视觉识别" in failed["error"]


def test_scan_image_imports_recognized_content_and_is_searchable(store: KbStore) -> None:
    imported = store.import_document(FIXTURES / "scan.png", recognition=RECOGNITION)

    assert imported["status"] == "ready"
    assert imported["type"] == "image"
    assert imported["sourceType"] == "vision"
    assert imported["confidence"] == 0.55
    assert imported["chunkCount"] == 3

    stored = next(doc for doc in store.list_documents() if doc["name"] == "scan.png")
    copied = Path(stored["path"])
    assert copied.is_file()
    assert copied.parent == store.root / "assets"

    hit = store.search("排水沟净宽")[0]
    assert hit["docName"] == "scan.png"
    assert hit["sourceType"] == "vision"
    assert hit["confidence"] == 0.55
    assert hit["location"]["region"]


def test_scan_recognition_failure_is_stored_with_reason(store: KbStore) -> None:
    failed = store.import_document(
        FIXTURES / "scan.png", recognition={"error": "视觉识别失败：图像过于模糊"}
    )

    assert failed["status"] == "failed"
    assert failed["error"] == "视觉识别失败：图像过于模糊"
    assert failed["chunkCount"] == 0


def test_rebuild_reuses_vision_recognition(store: KbStore) -> None:
    store.import_document(FIXTURES / "scan.png", recognition=RECOGNITION)

    summary = store.rebuild()

    assert summary["documents"] == 1
    assert summary["failed"] == 0
    assert summary["chunks"] == 3
    assert store.list_documents()[0]["name"] == "scan.png"
    hit = store.search("排水沟净宽")[0]
    assert hit["sourceType"] == "vision"
    assert hit["confidence"] == 0.55
