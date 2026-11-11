from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

SUPPORTED_SUFFIXES = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".dxf": "dxf",
    ".csv": "csv",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
}

CHUNK_SIZE = 400
CHUNK_OVERLAP = 60
EMBEDDING_DIM = 256
MIN_SCORE = 0.15
INDEX_FILE = "index.json"


def tokenize(text: str) -> list[str]:
    lowered = text.lower()
    tokens = re.findall(r"[a-z]+|\d+(?:\.\d+)?%?", lowered)
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        if len(run) == 1:
            tokens.append(run)
        tokens.extend(run[index : index + 2] for index in range(len(run) - 1))
    return tokens


def embed(tokens: list[str]) -> list[float]:
    vector = [0.0] * EMBEDDING_DIM
    for token in tokens:
        digest = hashlib.md5(token.encode("utf-8")).digest()
        slot = int.from_bytes(digest[:4], "big") % EMBEDDING_DIM
        vector[slot] += 1.0 if digest[4] & 1 else -1.0
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def _windows(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= CHUNK_SIZE:
        return [text] if text else []
    pieces = []
    step = CHUNK_SIZE - CHUNK_OVERLAP
    for start in range(0, len(text), step):
        piece = text[start : start + CHUNK_SIZE].strip()
        if piece:
            pieces.append(piece)
        if start + CHUNK_SIZE >= len(text):
            break
    return pieces


def _segments_pdf(path: Path) -> list[dict[str, Any]]:
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(path))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"PDF 解析失败：{exc}") from exc

    segments = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        for piece in _windows(text):
            segments.append({"text": piece, "location": {"page": page_number}})
    if not segments:
        raise ValueError("PDF 中没有可提取的文字")
    return segments


def _segments_docx(path: Path) -> list[dict[str, Any]]:
    from docx import Document

    try:
        document = Document(str(path))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Word 解析失败：{exc}") from exc

    segments: list[dict[str, Any]] = []
    buffer: list[str] = []
    start = 1
    length = 0

    def flush() -> None:
        nonlocal buffer, length
        if buffer:
            for piece in _windows("\n".join(buffer)):
                segments.append({"text": piece, "location": {"paragraph": start}})
        buffer = []
        length = 0

    for index, paragraph in enumerate(document.paragraphs, start=1):
        text = paragraph.text.strip()
        if not text:
            continue
        if not buffer:
            start = index
        buffer.append(text)
        length += len(text)
        if length >= CHUNK_SIZE - CHUNK_OVERLAP:
            flush()
    flush()

    if not segments:
        raise ValueError("Word 文档中没有文字内容")
    return segments


def _segments_dxf(path: Path) -> list[dict[str, Any]]:
    import ezdxf

    try:
        document = ezdxf.readfile(str(path))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"DXF 解析失败：{exc}") from exc

    segments: list[dict[str, Any]] = []
    for entity in document.modelspace():
        kind = entity.dxftype()
        if kind == "TEXT":
            text = entity.dxf.text
        elif kind == "MTEXT":
            text = entity.plain_text()
        else:
            continue
        text = text.strip()
        if not text:
            continue
        for piece in _windows(text):
            segments.append({"text": piece, "location": {"handle": entity.dxf.handle}})
    if not segments:
        raise ValueError("DXF 中没有文字内容")
    return segments


def _segments_csv(path: Path) -> list[dict[str, Any]]:
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"CSV 需使用 UTF-8 编码：{exc}") from exc

    try:
        rows = list(csv.reader(io.StringIO(text)))
    except csv.Error as exc:
        raise ValueError(f"CSV 解析失败：{exc}") from exc
    if len(rows) < 2:
        raise ValueError("CSV 中没有数据行")

    header = [cell.strip() or f"列{index + 1}" for index, cell in enumerate(rows[0])]
    segments = []
    for row_number, row in enumerate(rows[1:], start=1):
        parts = [
            f"{header[index]}: {cell.strip()}"
            for index, cell in enumerate(row)
            if cell.strip()
        ]
        if not parts:
            continue
        segments.append({"text": "；".join(parts), "location": {"row": row_number}})
    if not segments:
        raise ValueError("CSV 中没有有效数据行")
    return segments


def _segments_image(recognition: dict[str, Any] | None, path: Path) -> list[dict[str, Any]]:
    if recognition is None:
        raise ValueError(f"扫描图需要视觉识别：{path.name}")
    if recognition.get("error"):
        raise ValueError(str(recognition["error"]))

    segments: list[dict[str, Any]] = []
    description = str(recognition.get("description") or "").strip()
    if description:
        for piece in _windows(description):
            segments.append({"text": piece, "location": {"region": "概述"}})
    points = recognition.get("points") or []
    for index, point in enumerate(points, start=1):
        text = str(point).strip()
        if text:
            segments.append({"text": text, "location": {"region": f"要点 {index}"}})
    if not segments:
        raise ValueError("视觉识别结果中没有可入库的文字")
    return segments


_PARSERS = {
    "pdf": _segments_pdf,
    "docx": _segments_docx,
    "dxf": _segments_dxf,
    "csv": _segments_csv,
}


def parse_document(
    path: Path, recognition: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    suffix = path.suffix.lower()
    kind = SUPPORTED_SUFFIXES.get(suffix)
    if kind is None:
        raise ValueError(f"不支持的文件类型：{suffix or '未知'}")
    if kind == "image":
        return _segments_image(recognition, path)
    return _PARSERS[kind](path)


class KbStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._path = self.root / INDEX_FILE
        self._docs: list[dict[str, Any]] = []
        self._chunks: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        data = json.loads(self._path.read_text(encoding="utf-8"))
        self._docs = data.get("docs", [])
        self._chunks = data.get("chunks", [])

    def _persist(self) -> None:
        payload = {
            "docs": [
                {key: value for key, value in doc.items() if key != "chunks"}
                for doc in self._docs
            ],
            "chunks": self._chunks,
        }
        self._path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def _public_doc(self, doc: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in doc.items()
            if key not in {"chunks", "_recognition"}
        }

    def list_documents(self) -> list[dict[str, Any]]:
        return [self._public_doc(doc) for doc in self._docs]

    def import_document(
        self,
        path: Path | str,
        recognition: dict[str, Any] | None = None,
        doc_id: str | None = None,
        name: str | None = None,
    ) -> dict[str, Any]:
        source = Path(path).expanduser().resolve()
        doc_id = doc_id or hashlib.sha1(str(source).lower().encode("utf-8")).hexdigest()[:12]
        kind = SUPPORTED_SUFFIXES.get(source.suffix.lower(), source.suffix.lower().lstrip("."))
        confidence = recognition.get("confidence") if recognition else None
        if not isinstance(confidence, (int, float)):
            confidence = None

        doc: dict[str, Any] = {
            "id": doc_id,
            "name": name or source.name,
            "path": str(source),
            "type": kind,
            "sourceType": "vision" if kind == "image" else "text",
            "confidence": confidence,
            "status": "ready",
            "chunkCount": 0,
            "importedAt": int(source.stat().st_mtime) if source.exists() else 0,
            "error": None,
            "_recognition": recognition,
            "chunks": [],
        }

        try:
            if not source.is_file():
                raise ValueError("文件不存在")
            target = source
            if kind == "image":
                assets = self.root / "assets"
                assets.mkdir(parents=True, exist_ok=True)
                target = assets / f"{doc_id}{source.suffix.lower()}"
                if target != source:
                    shutil.copyfile(source, target)
                doc["path"] = str(target)
            segments = parse_document(target, recognition)
            for segment in segments:
                tokens = tokenize(segment["text"])
                chunk = {
                    "id": f"{doc_id}-{len(doc['chunks'])}",
                    "docId": doc_id,
                    "text": segment["text"],
                    "location": segment["location"],
                    "tokens": sorted(set(tokens)),
                    "vector": embed(tokens),
                    "sourceType": doc["sourceType"],
                }
                if confidence is not None:
                    chunk["confidence"] = confidence
                doc["chunks"].append(chunk)
            doc["chunkCount"] = len(doc["chunks"])
        except Exception as exc:  # noqa: BLE001
            doc["status"] = "failed"
            doc["error"] = str(exc)
            doc["chunks"] = []
            doc["chunkCount"] = 0

        self._docs = [existing for existing in self._docs if existing["id"] != doc_id]
        self._chunks = [chunk for chunk in self._chunks if chunk["docId"] != doc_id]
        self._docs.append(doc)
        self._chunks.extend(doc["chunks"])
        self._persist()
        return self._public_doc(doc) | {"chunks": doc["chunks"]}

    def delete(self, doc_id: str) -> bool:
        before = len(self._docs)
        self._docs = [doc for doc in self._docs if doc["id"] != doc_id]
        self._chunks = [chunk for chunk in self._chunks if chunk["docId"] != doc_id]
        removed = len(self._docs) != before
        if removed:
            self._persist()
        return removed

    def rebuild(self) -> dict[str, int]:
        previous = list(self._docs)
        self._docs = []
        self._chunks = []
        for doc in previous:
            self.import_document(
                doc["path"],
                recognition=doc.get("_recognition"),
                doc_id=doc["id"],
                name=doc["name"],
            )
        failed = sum(1 for doc in self._docs if doc["status"] != "ready")
        return {"documents": len(self._docs), "failed": failed, "chunks": len(self._chunks)}

    def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        query_tokens = tokenize(query)
        if not query_tokens:
            return []
        query_vector = embed(query_tokens)
        query_set = set(query_tokens)
        names = {doc["id"]: doc["name"] for doc in self._docs}

        scored = []
        for chunk in self._chunks:
            if chunk["docId"] not in names:
                continue
            cosine = sum(
                left * right for left, right in zip(query_vector, chunk["vector"], strict=True)
            )
            keyword = len(query_set & set(chunk["tokens"])) / len(query_set)
            score = 0.6 * max(cosine, 0.0) + 0.4 * keyword
            if score < MIN_SCORE:
                continue
            hit = {
                "docId": chunk["docId"],
                "docName": names[chunk["docId"]],
                "text": chunk["text"],
                "location": chunk["location"],
                "sourceType": chunk.get("sourceType", "text"),
                "score": round(score, 4),
            }
            if "confidence" in chunk:
                hit["confidence"] = chunk["confidence"]
            scored.append(hit)

        scored.sort(key=lambda hit: hit["score"], reverse=True)
        return scored[: max(1, limit)]
