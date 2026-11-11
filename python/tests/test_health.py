from cad_service.service import handle_request


def test_health_reports_service_and_ezdxf_version():
    response = handle_request({"id": "req-1", "method": "health", "params": {}})

    assert response["id"] == "req-1"
    assert response["ok"] is True
    assert response["result"]["service"] == "cad-service"
    assert response["result"]["ezdxf"].startswith("1.")
    assert response["result"]["python"].startswith("3.12")
