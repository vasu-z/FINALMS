from typing import List, Optional
from pydantic import BaseModel, Field


class DescribeResponse(BaseModel):
    description: str
    confidence: float = Field(
        default=0.90,
        ge=0.0,
        le=1.0,
        description="Confidence score between 0.0 and 1.0 (Safety Rule 2).",
    )


class ReadTextRequest(BaseModel):
    image_base64: str = Field(
        ...,
        description="Base64-encoded image data (JPEG, PNG, or WebP).",
    )
    mode: str = Field(
        default="balanced",
        description="Processing mode: 'fast' (lowest latency), 'balanced' (standard), or 'accurate' (high-fidelity math/handwriting).",
    )
    mime_type: Optional[str] = Field(
        default="image/jpeg",
        description="MIME type of the input image.",
    )


class ReadTextResponse(BaseModel):
    text: str = Field(
        ...,
        description="Verbatim transcribed text, notes, equations, and symbols.",
    )
    mode: str = Field(
        default="balanced",
        description="Processing mode used ('fast', 'balanced', 'accurate').",
    )
    confidence: float = Field(
        default=0.95,
        ge=0.0,
        le=1.0,
        description="Confidence score between 0.0 and 1.0 (Safety Rule 2).",
    )
    has_math: bool = Field(
        default=False,
        description="True if mathematical expressions or equations were detected and transcribed.",
    )
    reading_order_blocks: List[str] = Field(
        default_factory=list,
        description="Paragraphs or text blocks preserved in natural reading order (MinerU / PaddleOCR style).",
    )
    model: str = Field(
        default="gemma-4",
        description="Model name that generated the transcription.",
    )

