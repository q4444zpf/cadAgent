from __future__ import annotations

import json
import sys

from cad_service.service import handle_request


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            response = {
                "id": None,
                "ok": False,
                "error": {"code": "bad_json", "message": "request is not valid JSON"},
            }
        else:
            if isinstance(request, dict):
                response = handle_request(request)
            else:
                response = {
                    "id": None,
                    "ok": False,
                    "error": {"code": "bad_request", "message": "request must be a JSON object"},
                }

        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
