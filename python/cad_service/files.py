from __future__ import annotations

import fnmatch
import io
import os
import posixpath
import re
import shutil
import stat
import tarfile
import tempfile
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from cad_service.drawing import parse_dxf

IGNORED_DIRS = [
    ".git",
    ".pytest_cache",
    ".venv",
    ".vscode",
    ".idea",
    "__pycache__",
    "node_modules",
]

ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".zip", ".tar")
MAX_SCAN_ENTRIES = 5000
MAX_SCAN_DEPTH = 12
DEFAULT_SCAN_LIMIT = 200
MAX_SCAN_LIMIT = 1000
MAX_LIST_ENTRIES = 500
MAX_ARCHIVE_ENTRIES = 10_000
MAX_ARCHIVE_UNCOMPRESSED = 2 * 1024**3
ARCHIVE_BOMB_RATIO = 200
ARCHIVE_BOMB_MIN_BYTES = 100 * 1024**2
MAX_TARGET_ATTEMPTS = 50
MAX_READ_BYTES = 20 * 1024**2
DEFAULT_MAX_CHARS = 20_000
MAX_MAX_CHARS = 100_000
MAX_PDF_PAGES = 50
MAX_DOCX_PARAGRAPHS = 500

TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".log",
    ".ini",
    ".cfg",
    ".sql",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}

SECRET_PATTERNS = [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "*.keystore",
    "*.jks",
    "id_rsa*",
    "id_ed25519*",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "credentials*",
    "secrets*",
]


def scan_project(
    root: str,
    path: str = ".",
    extension: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    root_path = _resolve_root(root)
    target = _resolve_inside(root_path, path or ".")
    if not target.is_dir():
        raise ValueError(f"扫描路径不是目录：{_relative(target, root_path)}")

    entry_limit = _clamp_int(limit, 1, MAX_SCAN_LIMIT, DEFAULT_SCAN_LIMIT)
    ext_filter = _normalize_extension(extension)

    totals = {"files": 0, "dirs": 0, "archives": 0}
    by_extension: Counter[str] = Counter()
    entries: list[dict[str, Any]] = []
    warnings: list[str] = []
    truncated = False
    visited = 0

    def add_entry(item: os.DirEntry[str], entry_type: str, size: int, mtime_ms: int) -> None:
        entries.append(
            {
                "name": item.name,
                "path": _relative(Path(item.path), root_path),
                "type": entry_type,
                "size": size,
                "mtimeMs": mtime_ms,
                **({"extension": _extension(item.name)} if entry_type == "file" else {}),
                **({"format": _archive_format_name(item.name)} if entry_type == "archive" else {}),
            }
        )

    def walk(directory: Path, depth: int) -> None:
        nonlocal visited, truncated
        try:
            with os.scandir(directory) as handle:
                items = sorted(
                    handle,
                    key=lambda entry: (
                        0 if entry.is_dir(follow_symlinks=False) else 1,
                        entry.name.lower(),
                    ),
                )
        except OSError as error:
            warnings.append(f"无法读取目录 {_relative(directory, root_path)}：{error}")
            return

        for item in items:
            if visited >= MAX_SCAN_ENTRIES:
                truncated = True
                return
            visited += 1

            try:
                info = item.stat(follow_symlinks=False)
            except OSError:
                continue

            if item.is_symlink():
                if directory == target and ext_filter is None and len(entries) < entry_limit:
                    add_entry(item, "symlink", info.st_size, _mtime_ms(info))
                continue

            if item.is_dir(follow_symlinks=False):
                if item.name in IGNORED_DIRS:
                    continue
                if ext_filter is None:
                    totals["dirs"] += 1
                    if directory == target:
                        if len(entries) < entry_limit:
                            add_entry(item, "dir", 0, _mtime_ms(info))
                        else:
                            truncated = True
                if depth + 1 >= MAX_SCAN_DEPTH:
                    warnings.append(f"目录层级超过 {MAX_SCAN_DEPTH}，已跳过：{item.name}")
                    continue
                walk(Path(item.path), depth + 1)
                continue

            ext = _extension(item.name)
            is_archive = _is_archive_name(item.name)
            by_extension[ext] += 1
            if ext_filter is not None and ext != ext_filter:
                continue

            totals["files"] += 1
            if is_archive:
                totals["archives"] += 1
            if directory == target:
                if len(entries) < entry_limit:
                    add_entry(item, "archive" if is_archive else "file", info.st_size, _mtime_ms(info))
                else:
                    truncated = True

    walk(target, 0)

    if ext_filter is not None:
        filtered_files = by_extension.get(ext_filter, 0)
        by_extension = Counter({ext_filter: filtered_files})
        totals = {
            "files": filtered_files,
            "dirs": 0,
            "archives": filtered_files if ext_filter in {"zip", "tar", "tgz", "gz"} else 0,
        }

    if truncated:
        warnings.append(f"扫描结果已截断：单次最多枚举 {MAX_SCAN_ENTRIES} 个条目")

    return {
        "path": _relative(target, root_path),
        "entries": entries,
        "totals": totals,
        "byExtension": dict(by_extension),
        "truncated": truncated,
        "ignored": IGNORED_DIRS,
        "warnings": warnings,
    }


def list_archive(root: str, path: str) -> dict[str, Any]:
    root_path = _resolve_root(root)
    archive_path = _resolve_inside(root_path, path)
    if not archive_path.is_file():
        raise FileNotFoundError(f"压缩包不存在：{path}")

    archive_format = _archive_format(archive_path.name)
    if archive_format is None:
        raise ValueError(
            f"暂不支持该压缩格式：{archive_path.suffix or archive_path.name}，请先手动解压"
        )

    if archive_format == "zip":
        return _list_zip(archive_path)
    return _list_tar(archive_path, archive_format)


def extract_archive(root: str, path: str, target: str | None = None) -> dict[str, Any]:
    root_path = _resolve_root(root)
    archive_path = _resolve_inside(root_path, path)
    if not archive_path.is_file():
        raise FileNotFoundError(f"压缩包不存在：{path}")

    archive_format = _archive_format(archive_path.name)
    if archive_format is None:
        raise ValueError(
            f"暂不支持该压缩格式：{archive_path.suffix or archive_path.name}，请先手动解压"
        )

    if target:
        target_path = _resolve_inside(root_path, target)
        if target_path.exists():
            raise ValueError(f"目标目录已存在，不会覆盖：{_relative(target_path, root_path)}")
        target_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        target_path = _unique_target(archive_path.parent / f"{_archive_stem(archive_path.name)}_解压")

    total_bytes = (
        _preflight_zip(archive_path)
        if archive_format == "zip"
        else _preflight_tar(archive_path)
    )
    _check_bomb(archive_path, total_bytes)

    temp_path = Path(
        tempfile.mkdtemp(prefix=".extract-", dir=str(target_path.parent))
    )
    try:
        if archive_format == "zip":
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(temp_path)
        else:
            with tarfile.open(archive_path, "r:*") as archive:
                archive.extractall(temp_path, filter="data")

        files, directories, extracted = _measure_tree(temp_path)
        temp_path.rename(target_path)
    except Exception:
        shutil.rmtree(temp_path, ignore_errors=True)
        raise

    return {
        "path": _relative(archive_path, root_path),
        "target": _relative(target_path, root_path),
        "filesExtracted": files,
        "directoriesCreated": directories,
        "bytesExtracted": extracted,
    }


def read_file(root: str, path: str, max_chars: int | None = None) -> dict[str, Any]:
    root_path = _resolve_root(root)
    file_path = _resolve_inside(root_path, path)
    if not file_path.is_file():
        raise FileNotFoundError(f"文件不存在：{path}")

    _reject_secret(file_path, root_path)

    size = file_path.stat().st_size
    if size > MAX_READ_BYTES:
        raise ValueError(f"文件过大（{size} 字节），单次最多读取 {MAX_READ_BYTES} 字节")

    suffix = file_path.suffix.lower()
    relative = _relative(file_path, root_path)
    limit = _clamp_int(max_chars, 1, MAX_MAX_CHARS, DEFAULT_MAX_CHARS)

    if suffix == ".dxf":
        summary = parse_dxf(str(file_path), summary=True)
        return {
            "path": relative,
            "kind": "dxf",
            "size": size,
            "truncated": False,
            "encoding": None,
            "summary": summary,
        }

    if suffix == ".pdf":
        content, pages, truncated = _read_pdf(file_path, limit)
        return {
            "path": relative,
            "kind": "pdf",
            "size": size,
            "truncated": truncated,
            "encoding": None,
            "content": content,
            "pages": pages,
        }

    if suffix == ".docx":
        content, paragraphs, truncated = _read_docx(file_path, limit)
        return {
            "path": relative,
            "kind": "docx",
            "size": size,
            "truncated": truncated,
            "encoding": None,
            "content": content,
            "paragraphs": paragraphs,
        }

    if suffix in TEXT_EXTENSIONS:
        content, encoding, truncated = _read_text(file_path, limit)
        return {
            "path": relative,
            "kind": "text",
            "size": size,
            "truncated": truncated,
            "encoding": encoding,
            "content": content,
        }

    if suffix in IMAGE_EXTENSIONS:
        return {
            "path": relative,
            "kind": "image",
            "size": size,
            "truncated": False,
            "encoding": None,
            "content": "图片仅返回元数据，不做文字识别。",
        }

    raise ValueError(
        f"不支持读取该文件类型：{suffix or '未知'}；支持 DXF、PDF、DOCX、"
        "TXT/MD/CSV/JSON/YAML/XML/LOG/INI/CFG/SQL 与图片元数据"
    )


def _list_zip(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        total = sum(info.file_size for info in infos if not info.is_dir())
        entries = [_zip_entry(info) for info in infos[:MAX_LIST_ENTRIES]]
        return {
            "path": path.name,
            "format": "zip",
            "entryCount": len(infos),
            "totalUncompressedBytes": total,
            "entries": entries,
            "truncated": len(infos) > MAX_LIST_ENTRIES,
        }


def _zip_entry(info: zipfile.ZipInfo) -> dict[str, Any]:
    mode = (info.external_attr >> 16) & 0xFFFF
    modified = _zip_mtime(info)
    return {
        "name": info.filename,
        "size": info.file_size,
        "compressedSize": info.compress_size,
        "isDir": info.is_dir(),
        "isLink": stat.S_ISLNK(mode),
        "modifiedAt": modified,
    }


def _list_tar(path: Path, archive_format: str) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    count = 0
    total = 0
    truncated = False

    with tarfile.open(path, "r:*") as archive:
        for member in archive:
            count += 1
            if count > MAX_ARCHIVE_ENTRIES:
                truncated = True
                break
            if member.isfile():
                total += member.size
            if len(entries) < MAX_LIST_ENTRIES:
                entries.append(
                    {
                        "name": member.name,
                        "size": member.size,
                        "compressedSize": None,
                        "isDir": member.isdir(),
                        "isLink": member.issym() or member.islnk(),
                        "modifiedAt": int(member.mtime * 1000) if member.mtime else None,
                    }
                )

    return {
        "path": path.name,
        "format": archive_format,
        "entryCount": count,
        "totalUncompressedBytes": total,
        "entries": entries,
        "truncated": truncated,
    }


def _preflight_zip(path: Path) -> int:
    total = 0
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ARCHIVE_ENTRIES:
            raise ValueError(f"压缩包条目数超过上限：{len(infos)} > {MAX_ARCHIVE_ENTRIES}")
        for info in infos:
            _validate_member_name(info.filename)
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise ValueError(f"压缩包成员包含符号链接：{info.filename}")
            if info.flag_bits & 0x1:
                raise ValueError(f"压缩包成员已加密，暂不支持：{info.filename}")
            if not info.is_dir():
                total += info.file_size
                if total > MAX_ARCHIVE_UNCOMPRESSED:
                    raise ValueError(
                        f"压缩包解压总量超过上限：{MAX_ARCHIVE_UNCOMPRESSED} 字节"
                    )
    return total


def _preflight_tar(path: Path) -> int:
    total = 0
    count = 0
    with tarfile.open(path, "r:*") as archive:
        for member in archive:
            count += 1
            if count > MAX_ARCHIVE_ENTRIES:
                raise ValueError(f"压缩包条目数超过上限：{count} > {MAX_ARCHIVE_ENTRIES}")
            _validate_member_name(member.name)
            if member.issym() or member.islnk():
                raise ValueError(f"压缩包成员包含链接：{member.name}")
            if member.ischr() or member.isblk() or member.isfifo():
                raise ValueError(f"压缩包成员类型不受支持：{member.name}")
            if member.isfile():
                total += member.size
                if total > MAX_ARCHIVE_UNCOMPRESSED:
                    raise ValueError(
                        f"压缩包解压总量超过上限：{MAX_ARCHIVE_UNCOMPRESSED} 字节"
                    )
    return total


def _validate_member_name(name: str) -> None:
    raw = name.replace("\\", "/")
    if not raw or "\x00" in raw:
        raise ValueError(f"压缩包成员路径不安全：{name}")
    if raw.startswith("/") or raw.startswith("//") or re.match(r"^[A-Za-z]:", raw):
        raise ValueError(f"压缩包成员路径不安全：{name}")
    normalized = posixpath.normpath(raw)
    if normalized in {".", ".."} or normalized.startswith("../") or normalized.startswith("/"):
        raise ValueError(f"压缩包成员路径不安全：{name}")
    if any(part in {"", ".."} for part in normalized.split("/")):
        raise ValueError(f"压缩包成员路径不安全：{name}")


def _check_bomb(path: Path, total: int) -> None:
    archive_size = path.stat().st_size
    if (
        archive_size > 0
        and total > ARCHIVE_BOMB_MIN_BYTES
        and total / archive_size > ARCHIVE_BOMB_RATIO
    ):
        raise ValueError(
            f"压缩包解压比异常（{total // archive_size} 倍），已拒绝以防压缩炸弹"
        )


def _measure_tree(root: Path) -> tuple[int, int, int]:
    files = 0
    directories = 0
    total = 0
    for current, dirnames, filenames in os.walk(root):
        directories += len(dirnames)
        for name in filenames:
            files += 1
            try:
                total += (Path(current) / name).stat().st_size
            except OSError:
                continue
    return files, directories, total


def _read_text(path: Path, limit: int) -> tuple[str, str, bool]:
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        text = data.decode("utf-8-sig", errors="replace")
        encoding = "utf-8-sig"
    else:
        text = ""
        encoding = "utf-8"
        for candidate in ("utf-8", "gb18030"):
            try:
                text = data.decode(candidate)
                encoding = candidate
                break
            except UnicodeDecodeError:
                continue
        else:
            text = data.decode("utf-8", errors="replace")
            encoding = "utf-8"
    truncated = len(text) > limit
    return text[:limit], encoding, truncated


def _read_pdf(path: Path, limit: int) -> tuple[str, int, bool]:
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(path))
    except Exception as error:
        raise ValueError(f"无法读取 PDF：{error}") from error

    pages = len(reader.pages)
    chunks: list[str] = []
    for index, page in enumerate(reader.pages[:MAX_PDF_PAGES]):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        chunks.append(f"第 {index + 1} 页\n{text}")
    content = "\n\n".join(chunks)
    truncated = pages > MAX_PDF_PAGES or len(content) > limit
    return content[:limit], pages, truncated


def _read_docx(path: Path, limit: int) -> tuple[str, int, bool]:
    from docx import Document

    try:
        document = Document(str(path))
    except Exception as error:
        raise ValueError(f"无法读取 DOCX：{error}") from error

    paragraphs = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
    selected = paragraphs[:MAX_DOCX_PARAGRAPHS]
    content = "\n".join(selected)
    truncated = len(paragraphs) > MAX_DOCX_PARAGRAPHS or len(content) > limit
    return content[:limit], len(paragraphs), truncated


def _reject_secret(path: Path, root: Path) -> None:
    name = path.name.lower()
    if any(fnmatch.fnmatch(name, pattern) for pattern in SECRET_PATTERNS):
        raise ValueError(f"拒绝读取敏感文件：{_relative(path, root)}")
    parts = [part.lower() for part in path.relative_to(root).parts[:-1]]
    if ".git" in parts:
        raise ValueError(f"拒绝读取版本库内部文件：{_relative(path, root)}")


def _resolve_root(root: str) -> Path:
    if not isinstance(root, str) or not root.strip():
        raise ValueError("缺少项目根目录参数")
    path = Path(root).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"项目根目录不存在：{root}")
    return path


def _resolve_inside(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("缺少路径参数")
    if "\x00" in relative:
        raise ValueError("路径包含非法字符")
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"路径超出项目范围：{relative}")
    return candidate


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _extension(name: str) -> str:
    return Path(name).suffix.lower().lstrip(".")


def _normalize_extension(extension: str | None) -> str | None:
    if extension is None:
        return None
    if not isinstance(extension, str):
        raise ValueError("extension 参数必须是字符串")
    value = extension.strip().lower().lstrip(".")
    return value or None


def _is_archive_name(name: str) -> bool:
    return _archive_format(name) is not None


def _archive_format(name: str) -> str | None:
    lower = name.lower()
    if lower.endswith(".tar.gz"):
        return "tar.gz"
    if lower.endswith(".tgz"):
        return "tgz"
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith(".tar"):
        return "tar"
    return None


def _archive_format_name(name: str) -> str:
    return _archive_format(name) or "unknown"


def _archive_stem(name: str) -> str:
    lower = name.lower()
    for suffix in (".tar.gz", ".tgz", ".zip", ".tar"):
        if lower.endswith(suffix):
            return name[: -len(suffix)]
    return Path(name).stem


def _unique_target(base: Path) -> Path:
    if not base.exists():
        return base
    for index in range(2, MAX_TARGET_ATTEMPTS + 1):
        candidate = base.with_name(f"{base.name}-{index}")
        if not candidate.exists():
            return candidate
    raise ValueError("同名解压目录过多，请指定目标目录")


def _zip_mtime(info: zipfile.ZipInfo) -> int | None:
    try:
        return int(datetime(*info.date_time).timestamp() * 1000)
    except (ValueError, OverflowError):
        return None


def _mtime_ms(info: os.stat_result) -> int:
    return int(info.st_mtime * 1000)


def _clamp_int(value: Any, minimum: int, maximum: int, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return min(max(int(value), minimum), maximum)


__all__ = ["scan_project", "list_archive", "extract_archive", "read_file"]
