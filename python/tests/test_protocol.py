from pathlib import Path

from cad_service.service import handle_request

FIXTURES = Path(__file__).resolve().parents[2] / "samples" / "kb"


def test_unknown_method_returns_structured_error():
    response = handle_request({"id": "req-2", "method": "nope", "params": {}})

    assert response == {
        "id": "req-2",
        "ok": False,
        "error": {"code": "unknown_method", "message": "unknown method: nope"},
    }


def test_kb_methods_roundtrip(tmp_path):
    root = str(tmp_path / "kb")

    imported = handle_request(
        {
            "id": "kb-1",
            "method": "kb_import",
            "params": {"root": root, "path": str(FIXTURES / "params.csv")},
        }
    )
    assert imported["ok"] is True
    assert imported["result"]["status"] == "ready"

    listed = handle_request({"id": "kb-2", "method": "kb_list", "params": {"root": root}})
    assert [doc["name"] for doc in listed["result"]["documents"]] == ["params.csv"]

    searched = handle_request(
        {
            "id": "kb-3",
            "method": "kb_search",
            "params": {"root": root, "query": "纵坡 0.3"},
        }
    )
    assert searched["ok"] is True
    assert searched["result"]["hits"][0]["docName"] == "params.csv"
    assert searched["result"]["hits"][0]["location"] == {"row": 2}

    rebuilt = handle_request({"id": "kb-4", "method": "kb_rebuild", "params": {"root": root}})
    assert rebuilt["result"] == {"documents": 1, "failed": 0, "chunks": 3}

    deleted = handle_request(
        {
            "id": "kb-5",
            "method": "kb_delete",
            "params": {"root": root, "docId": imported["result"]["id"]},
        }
    )
    assert deleted["result"] == {"deleted": True}


def test_kb_requires_root():
    response = handle_request(
        {"id": "kb-6", "method": "kb_list", "params": {}}
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "handler_error"
