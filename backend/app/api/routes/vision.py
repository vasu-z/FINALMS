import base64
import binascii
import logging
from typing import Optional
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from google.genai import types

from app.core.config import get_settings
from app.schemas.vision import (
    DescribeResponse,
    ReadTextRequest,
    ReadTextResponse,
)
from app.services.gemini import (
    GeminiCredentialsMissingException,
    GeminiServiceException,
    get_gemini_client,
)
from app.services.image_processor import (
    ImageProcessingError,
    preprocess_image_for_text_reading,
)

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_IMAGE_SIZE = 8 * 1024 * 1024  # 8 MB

SUPPORTED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
}

FILE_SIGNATURES: list[tuple[bytes, str]] = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"RIFF", "image/webp"),
]

DEFAULT_QUESTION = (
    "Describe this scene for a blind or low-vision user. "
    "Identify clearly visible objects, their positions relative to each other, "
    "any readable text, and potential obstacles. "
    "Only describe what is clearly visible. "
    "Express uncertainty when a detail is unclear rather than guessing."
)

READ_TEXT_PROMPT = (
    "Transcribe all visible text, handwritten notes, mathematical expressions, and symbols in this image faithfully without summarizing or interpreting.\n"
    "- Preserve the original language, spelling, punctuation, capitalization, and natural reading order.\n"
    "- Faithfully transcribe mathematical symbols, equations, formulas, superscripts, subscripts, and matrix notation.\n"
    "- Never silently correct, complete, or alter the author's writing.\n"
    "- Mark illegible or uncertain words and symbols as [unclear] rather than guessing.\n"
    "- Do not invent headings, commentary, or repeating duplicate text not present in the image.\n"
    "- Provide a clear transcription suitable for reading aloud to a visually impaired user.\n"
    "- If no readable text or symbols are visible in the image, state that no readable text was detected."
)

VALID_MODES = {"fast", "balanced", "accurate"}

MODE_CONFIGS: dict[str, dict] = {
    "fast": {"temperature": 0.1, "max_output_tokens": 512},
    "balanced": {"temperature": 0.1, "max_output_tokens": 2048},
    "accurate": {"temperature": 0.0, "max_output_tokens": 4096},
}

MOCK_OCR_TEXT = (
    "Lecture Notes: Discrete Mathematics & Algorithms\n\n"
    "Topic 1: Asymptotic Complexity & Big-O Notation\n"
    "Definition: f(n) = O(g(n)) if there exist positive constants c and n0 such that 0 <= f(n) <= c * g(n) for all n >= n0.\n\n"
    "Topic 2: Important Closed Formulas\n"
    "1. Sum of first n integers: sum(i=1 to n) i = n(n + 1) / 2\n"
    "2. Mass-energy equivalence: E = mc^2\n\n"
    "Reminder: Midterm exam on Thursday in Hall 302."
)


def _infer_mime_type(header: bytes) -> Optional[str]:
    for signature, mime in FILE_SIGNATURES:
        if header.startswith(signature):
            return mime
    if header[:4] == b"RIFF" and len(header) >= 12 and header[8:12] == b"WEBP":
        return "image/webp"
    return None


async def _validate_and_read_image(image: UploadFile) -> tuple[bytes, str]:
    content_type = (image.content_type or "").lower().split(";")[0].strip()
    if content_type == "image/jpg":
        content_type = "image/jpeg"

    if content_type not in SUPPORTED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported media type '{content_type}'. Supported: jpeg, png, webp.",
        )

    image_bytes = await image.read()

    if not image_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Image file is empty.",
        )

    if len(image_bytes) > MAX_IMAGE_SIZE:
        max_mb = MAX_IMAGE_SIZE // (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Image exceeds the maximum allowed size of {max_mb} MB.",
        )

    inferred = _infer_mime_type(image_bytes[:12])
    if inferred is None or inferred not in SUPPORTED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="File content does not match a supported image format (jpeg, png, webp).",
        )

    return image_bytes, inferred


def _contains_math_notation(text: str) -> bool:
    math_indicators = ["=", "+", "-", "*", "/", "^", "\\sum", "\\int", "\\sqrt", "E = mc^2", "O(", "<="]
    return any(indicator in text for indicator in math_indicators)


def _split_reading_blocks(text: str) -> list[str]:
    blocks = [b.strip() for b in text.split("\n\n") if b.strip()]
    return blocks if blocks else [text.strip()]


@router.post("/describe", response_model=DescribeResponse, summary="Describe scene from uploaded image")
async def describe_scene(
    image: UploadFile = File(...),
    question: Optional[str] = Form(default=None),
) -> DescribeResponse:
    settings = get_settings()
    image_bytes, mime_type = await _validate_and_read_image(image)
    prompt = question.strip() if (question and question.strip()) else DEFAULT_QUESTION

    if not settings.is_gemini_configured:
        if settings.ENABLE_AI_MOCK:
            return DescribeResponse(
                description="[MOCK AI] In front of you is a clear study desk with printed lecture notes and a notebook.",
                confidence=0.90,
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI credentials are not configured. Contact the server administrator.",
        )

    try:
        client = get_gemini_client(api_key=settings.GEMINI_API_KEY)
        image_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
        response = client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[image_part, prompt],
        )
        if not response or not response.text:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI model returned an empty response. Please try again.",
            )
        return DescribeResponse(description=response.text.strip(), confidence=0.92)
    except GeminiCredentialsMissingException as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI credentials are not configured. Contact the server administrator.",
        ) from exc
    except Exception as exc:
        logger.error("Vision describe error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI model could not process the image. Please try again.",
        ) from exc


@router.post("/read-text", response_model=ReadTextResponse, summary="Transcribe verbatim notes, handwriting, equations and text")
async def read_text(
    image: UploadFile = File(...),
    mode: str = Form(default="balanced"),
) -> ReadTextResponse:
    settings = get_settings()
    normalized_mode = (mode or "balanced").strip().lower()
    if normalized_mode not in VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid mode '{mode}'. Supported modes: fast, balanced, accurate.",
        )

    raw_bytes, raw_mime = await _validate_and_read_image(image)

    try:
        processed_bytes, mime_type = preprocess_image_for_text_reading(
            image_bytes=raw_bytes,
            mime_type=raw_mime,
            mode=normalized_mode,
        )
    except ImageProcessingError as exc:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Image content is corrupted or unreadable.",
        ) from exc

    # Handle Mock mode for offline / local testing
    if not settings.is_gemini_configured:
        if settings.ENABLE_AI_MOCK:
            return ReadTextResponse(
                text=MOCK_OCR_TEXT,
                mode=normalized_mode,
                confidence=0.95,
                has_math=True,
                reading_order_blocks=_split_reading_blocks(MOCK_OCR_TEXT),
                model=f"mock-{settings.GEMINI_MODEL}",
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI credentials are not configured. Contact the server administrator.",
        )

    # Live Gemma 4 / Gemini Vision OCR execution
    try:
        cfg = MODE_CONFIGS[normalized_mode]
        gen_config = types.GenerateContentConfig(
            temperature=cfg["temperature"],
            max_output_tokens=cfg["max_output_tokens"],
        )

        client = get_gemini_client(api_key=settings.GEMINI_API_KEY)
        image_part = types.Part.from_bytes(data=processed_bytes, mime_type=mime_type)
        response = client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[image_part, READ_TEXT_PROMPT],
            config=gen_config,
        )

        if not response or not response.text:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI model returned an empty response. Please try again.",
            )

        extracted_text = response.text.strip()
        has_math = _contains_math_notation(extracted_text)
        blocks = _split_reading_blocks(extracted_text)
        confidence = 0.80 if "[unclear]" in extracted_text else 0.95

        return ReadTextResponse(
            text=extracted_text,
            mode=normalized_mode,
            confidence=confidence,
            has_math=has_math,
            reading_order_blocks=blocks,
            model=settings.GEMINI_MODEL,
        )

    except GeminiCredentialsMissingException as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI credentials are not configured. Contact the server administrator.",
        ) from exc
    except Exception as exc:
        logger.error("Vision OCR read-text error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI model could not process the text image. Please try again.",
        ) from exc


@router.post("/read-text-json", response_model=ReadTextResponse, summary="Transcribe text from Base64 JSON payload")
async def read_text_json(request: ReadTextRequest) -> ReadTextResponse:
    settings = get_settings()
    normalized_mode = (request.mode or "balanced").strip().lower()
    if normalized_mode not in VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid mode '{request.mode}'. Supported modes: fast, balanced, accurate.",
        )

    raw_b64 = request.image_base64.strip()
    if raw_b64.startswith("data:") and "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1].strip()

    try:
        raw_bytes = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or malformed Base64 image data.",
        )

    if not raw_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Image data is empty.",
        )

    if len(raw_bytes) > MAX_IMAGE_SIZE:
        max_mb = MAX_IMAGE_SIZE // (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Image exceeds the maximum allowed size of {max_mb} MB.",
        )

    declared_mime = (request.mime_type or "image/jpeg").lower().strip()
    if declared_mime == "image/jpg":
        declared_mime = "image/jpeg"
    if declared_mime not in SUPPORTED_MIME_TYPES:
        inferred = _infer_mime_type(raw_bytes[:12])
        if inferred in SUPPORTED_MIME_TYPES:
            declared_mime = inferred
        else:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=f"Unsupported image MIME type '{request.mime_type}'. Supported: jpeg, png, webp.",
            )

    try:
        processed_bytes, mime_type = preprocess_image_for_text_reading(
            image_bytes=raw_bytes,
            mime_type=declared_mime,
            mode=normalized_mode,
        )
    except ImageProcessingError as exc:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Image content is corrupted or unreadable.",
        ) from exc

    if not settings.is_gemini_configured:
        if settings.ENABLE_AI_MOCK:
            return ReadTextResponse(
                text=MOCK_OCR_TEXT,
                mode=normalized_mode,
                confidence=0.95,
                has_math=True,
                reading_order_blocks=_split_reading_blocks(MOCK_OCR_TEXT),
                model=f"mock-{settings.GEMINI_MODEL}",
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI credentials are not configured. Contact the server administrator.",
        )

    try:
        cfg = MODE_CONFIGS[normalized_mode]
        gen_config = types.GenerateContentConfig(
            temperature=cfg["temperature"],
            max_output_tokens=cfg["max_output_tokens"],
        )

        client = get_gemini_client(api_key=settings.GEMINI_API_KEY)
        image_part = types.Part.from_bytes(data=processed_bytes, mime_type=mime_type)
        response = client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[image_part, READ_TEXT_PROMPT],
            config=gen_config,
        )

        if not response or not response.text:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI model returned an empty response. Please try again.",
            )

        extracted_text = response.text.strip()
        has_math = _contains_math_notation(extracted_text)
        blocks = _split_reading_blocks(extracted_text)
        confidence = 0.80 if "[unclear]" in extracted_text else 0.95

        return ReadTextResponse(
            text=extracted_text,
            mode=normalized_mode,
            confidence=confidence,
            has_math=has_math,
            reading_order_blocks=blocks,
            model=settings.GEMINI_MODEL,
        )
    except GeminiCredentialsMissingException as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI credentials are not configured. Contact the server administrator.",
        ) from exc
    except Exception as exc:
        logger.error("Vision OCR read-text-json error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI model could not process the text image. Please try again.",
        ) from exc

