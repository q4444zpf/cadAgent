from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

from cad_service.drawing import close_dxf, layer_entities, open_dxf, parse_dxf
from cad_service.files import extract_archive, list_archive, read_file, scan_project
from cad_service.kb import KbStore

SERVICE_NAME = "cad-service"
SERVICE_VERSION = "0.1.0"


def _health(_: dict[str, Any]) -> dict[str, Any]:
    import ezdxf

    return {
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "ezdxf": ezdxf.__version__,
        "python": sys.version.split()[0],
    }


def _parse_dxf(params: dict[str, Any]) -> dict[str, Any]:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("parse_dxf 需要非空的 path 参数")
    return parse_dxf(path, summary=params.get("summary") is True)


def _path_param(params: dict[str, Any], method: str) -> str:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError(f"{method} 需要非空的 path 参数")
    return path


def _open_dxf(params: dict[str, Any]) -> dict[str, Any]:
    return open_dxf(_path_param(params, "open_dxf"))


def _layer_entities(params: dict[str, Any]) -> dict[str, Any]:
    path = _path_param(params, "layer_entities")
    layer = params.get("layer")
    if not isinstance(layer, str) or not layer:
        raise ValueError("layer_entities 需要非空的 layer 参数")
    return layer_entities(path, layer)


def _close_dxf(_: dict[str, Any]) -> dict[str, Any]:
    close_dxf()
    return {"closed": True}


def _project_root(params: dict[str, Any]) -> str:
    root = params.get("root")
    if not isinstance(root, str) or not root:
        raise ValueError("项目请求需要非空的 root 参数")
    return root


def _optional_str(params: dict[str, Any], name: str) -> str | None:
    value = params.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} 参数必须是字符串")
    return value


def _project_scan(params: dict[str, Any]) -> dict[str, Any]:
    return scan_project(
        _project_root(params),
        path=_optional_str(params, "path") or ".",
        extension=_optional_str(params, "extension"),
        limit=params.get("limit"),
    )


def _archive_list(params: dict[str, Any]) -> dict[str, Any]:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("archive_list 需要非空的 path 参数")
    return list_archive(_project_root(params), path)


def _archive_extract(params: dict[str, Any]) -> dict[str, Any]:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("archive_extract 需要非空的 path 参数")
    return extract_archive(
        _project_root(params),
        path,
        target=_optional_str(params, "target"),
    )


def _read_file(params: dict[str, Any]) -> dict[str, Any]:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("read_file 需要非空的 path 参数")
    return read_file(
        _project_root(params),
        path,
        max_chars=params.get("maxChars"),
    )


def _store(params: dict[str, Any]) -> KbStore:
    root = params.get("root")
    if not isinstance(root, str) or not root:
        raise ValueError("知识库请求需要非空的 root 参数")
    return KbStore(Path(root))


def _kb_import(params: dict[str, Any]) -> dict[str, Any]:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("kb_import 需要非空的 path 参数")
    recognition = params.get("recognition")
    if recognition is not None and not isinstance(recognition, dict):
        raise ValueError("kb_import 的 recognition 必须是对象")
    return _store(params).import_document(path, recognition=recognition)


def _kb_list(params: dict[str, Any]) -> dict[str, Any]:
    return {"documents": _store(params).list_documents()}


def _kb_delete(params: dict[str, Any]) -> dict[str, Any]:
    doc_id = params.get("docId")
    if not isinstance(doc_id, str) or not doc_id:
        raise ValueError("kb_delete 需要非空的 docId 参数")
    return {"deleted": _store(params).delete(doc_id)}


def _kb_rebuild(params: dict[str, Any]) -> dict[str, Any]:
    return _store(params).rebuild()


def _kb_search(params: dict[str, Any]) -> dict[str, Any]:
    query = params.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("kb_search 需要非空的 query 参数")
    limit = params.get("limit")
    limit = int(limit) if isinstance(limit, (int, float)) else 5
    return {"hits": _store(params).search(query, limit=limit)}


_HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "health": _health,
    "parse_dxf": _parse_dxf,
    "open_dxf": _open_dxf,
    "layer_entities": _layer_entities,
    "close_dxf": _close_dxf,
    "project_scan": _project_scan,
    "archive_list": _archive_list,
    "archive_extract": _archive_extract,
    "read_file": _read_file,
    "kb_import": _kb_import,
    "kb_list": _kb_list,
    "kb_delete": _kb_delete,
    "kb_rebuild": _kb_rebuild,
    "kb_search": _kb_search,
}


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}
    handler = _HANDLERS.get(method)
    if handler is None:
        return {
            "id": request_id,
            "ok": False,
            "error": {"code": "unknown_method", "message": f"unknown method: {method}"},
        }
    try:
        result = handler(params)
    except Exception as exc:
        return {
            "id": request_id,
            "ok": False,
            "error": {"code": "handler_error", "message": str(exc)},
        }
    return {"id": request_id, "ok": True, "result": result}
