import base64
import io
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.services.image_processor import (
    ImageProcessingError,
    preprocess_image_for_text_reading,
)

client = TestClient(app)


def _create_test_image(format: str = "JPEG", size: tuple[int, int] = (200, 100), mode: str = "RGB") -> bytes:
    img = Image.new(mode, size, color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format=format)
    return buf.getvalue()


def test_preprocess_image_valid_jpeg():
    raw_bytes = _create_test_image(format="JPEG")
    processed_bytes, out_mime = preprocess_image_for_text_reading(raw_bytes, "image/jpeg", mode="balanced")
    assert len(processed_bytes) > 0
    assert out_mime == "image/jpeg"


def test_preprocess_image_rgba_flattening():
    raw_bytes = _create_test_image(format="PNG", mode="RGBA")
    processed_bytes, out_mime = preprocess_image_for_text_reading(raw_bytes, "image/png", mode="accurate")
    assert len(processed_bytes) > 0
    assert out_mime == "image/png"


def test_preprocess_image_resizes_large_dimensions():
    # Large image > 2560px
    raw_bytes = _create_test_image(format="JPEG", size=(3000, 2000))
    processed_bytes, out_mime = preprocess_image_for_text_reading(raw_bytes, "image/jpeg", mode="fast")
    processed_img = Image.open(io.BytesIO(processed_bytes))
    assert max(processed_img.width, processed_img.height) <= 2560


def test_preprocess_image_corrupted_data():
    with pytest.raises(ImageProcessingError):
        preprocess_image_for_text_reading(b"not-an-image", "image/jpeg")


def test_read_text_multipart_mock_mode():
    img_bytes = _create_test_image(format="JPEG")
    response = client.post(
        "/api/v1/vision/read-text",
        files={"image": ("notes.jpg", img_bytes, "image/jpeg")},
        data={"mode": "balanced"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "text" in data
    assert data["mode"] == "balanced"
    assert data["confidence"] >= 0.8
    assert "reading_order_blocks" in data
    assert len(data["reading_order_blocks"]) > 0


def test_read_text_modes_and_validation():
    img_bytes = _create_test_image(format="PNG")

    for mode in ("fast", "balanced", "accurate"):
        resp = client.post(
            "/api/v1/vision/read-text",
            files={"image": ("test.png", img_bytes, "image/png")},
            data={"mode": mode},
        )
        assert resp.status_code == 200
        assert resp.json()["mode"] == mode

    # Invalid mode
    invalid_resp = client.post(
        "/api/v1/vision/read-text",
        files={"image": ("test.png", img_bytes, "image/png")},
        data={"mode": "ultra_hd"},
    )
    assert invalid_resp.status_code == 422


def test_read_text_unsupported_media():
    resp = client.post(
        "/api/v1/vision/read-text",
        files={"image": ("file.txt", b"plain text", "text/plain")},
        data={"mode": "balanced"},
    )
    assert resp.status_code == 415


def test_read_text_json_endpoint():
    img_bytes = _create_test_image(format="JPEG")
    b64_str = base64.b64encode(img_bytes).decode("utf-8")

    response = client.post(
        "/api/v1/vision/read-text-json",
        json={
            "image_base64": b64_str,
            "mode": "accurate",
            "mime_type": "image/jpeg",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert "text" in data
    assert data["mode"] == "accurate"
    assert data["confidence"] >= 0.8


def test_describe_scene_endpoint():
    img_bytes = _create_test_image(format="JPEG")
    response = client.post(
        "/api/v1/vision/describe",
        files={"image": ("scene.jpg", img_bytes, "image/jpeg")},
        data={"question": "What is in front of me?"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "description" in data
    assert data["confidence"] >= 0.8

