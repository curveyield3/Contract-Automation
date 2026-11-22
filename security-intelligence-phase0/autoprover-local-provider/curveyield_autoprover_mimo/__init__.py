"""CurveYield Security Pipeline v1 — original Composer ProviderSpec bridge.

Compatibility source (read-only): Certora/AutoProver at
81d9626c249a70c0a0f0648a89de175443c0344c:
composer/llm/provider.py, registry.py, openai.py, input/files.py.
This module is never authority to run AutoProver or to accept an audit.
It cannot upload files to remote vendor APIs or change any upstream agents.
Native Composer interface qualification and local MiMo tool-call support remain
separate, required G6 observations; this source is not a tested native provider.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import openai

from composer.input.files import (
    ContentRenderer,
    Document,
    FileData,
    InMemoryTextFile,
    TextDocument,
    UploaderBase,
    Uploadable,
)
from composer.input.types import ModelConfiguration
from composer.llm.pricing import PriceProvider, PriceTier
from composer.llm.provider import (
    ProviderServiceBase,
    ProviderSpec,
    compaction_threshold,
    standard_callbacks,
)
from composer.llm.types import CacheLevel

ADAPTER_VERSION = "v1"
UPSTREAM_INTERFACE_COMMIT = "81d9626c249a70c0a0f0648a89de175443c0344c"
MODEL_ALIAS = "lite-solo-mimo-v1"
LOCAL_BASE_URL = "http://127.0.0.1:8080/v1"
# Match the G2A job-local launch's fixed --ctx-size; native capacity must be
# independently demonstrated before the provider is eligible for G7.
CONTEXT_WINDOW = 4096
MAX_COMPLETION_TOKENS = 1024
MAX_LOCAL_INLINE_BYTES = 8192


class LocalMiMoDocumentUnsupported(ValueError):
    """A document cannot be represented faithfully by the local Chat API."""


@dataclass
class LocalMiMoRenderer:
    """Only literal UTF-8 text can enter the original local Chat API."""

    def text_block(
        self, text: str, *, cache_level: CacheLevel = CacheLevel.NONE
    ) -> dict[str, Any]:
        if len(text.encode("utf-8")) > MAX_LOCAL_INLINE_BYTES:
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_TEXT_DOCUMENT_EXCEEDS_VERIFIED_INLINE_BYTE_BUDGET"
            )
        return {"type": "text", "text": text}

    def file_block(
        self, file_id: str, *, cache_level: CacheLevel = CacheLevel.NONE
    ) -> dict[str, Any]:
        raise LocalMiMoDocumentUnsupported(
            "LOCAL_MIMO_HAS_NO_EXTERNAL_FILES_API_OR_UPLOAD_IDS"
        )

    def inline_file_block(
        self, basename: str, contents: bytes, mime: str,
        *, cache_level: CacheLevel = CacheLevel.NONE
    ) -> dict[str, Any]:
        if not mime.startswith("text/"):
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_BINARY_DOCUMENT_UNSUPPORTED_NO_SILENT_DROP"
            )
        try:
            contents_text = contents.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_DOCUMENT_NOT_UTF8"
            ) from exc
        return self.text_block(contents_text, cache_level=cache_level)


@dataclass
class LocalMiMoUploader(UploaderBase):
    """Original Composer uploader protocol, with no outbound Files API."""

    renderer: ContentRenderer = field(default_factory=LocalMiMoRenderer)

    async def _upload_bytes(
        self, crc_basename: str, file_data: bytes, mime: str
    ) -> str:
        raise LocalMiMoDocumentUnsupported(
            "LOCAL_MIMO_FILE_UPLOAD_FORBIDDEN_NO_REMOTE_PROVIDER"
        )

    async def _binary_document(self, data: FileData) -> Document:
        raise LocalMiMoDocumentUnsupported(
            "LOCAL_MIMO_BINARY_DOCUMENT_UNSUPPORTED_NO_NATIVE_PDF_HANDLING"
        )

    async def _text_upload_document(self, data: FileData) -> TextDocument:
        if len(data.raw_data) > MAX_LOCAL_INLINE_BYTES:
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_TEXT_UPLOAD_TOO_LARGE_FOR_LOCAL_CONTEXT"
            )
        try:
            text = data.raw_data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise LocalMiMoDocumentUnsupported("LOCAL_MIMO_TEXT_NOT_UTF8") from exc
        return InMemoryTextFile(
            basename=data.basename, string_contents=text, renderer=self.renderer
        )

    async def upload_file_if_needed(
        self, file_path: str | Path
    ) -> Document:
        # The original implementation can route this through remote Files APIs.
        # For local MiMo, preserve text and refuse binary rather than uploading.
        original = await self.get_document(file_path)
        if original is None:
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_FILE_NOT_PRESENT_IN_TRUSTED_CHECKOUT"
            )
        return original

    async def get_document(self, path: str | Path) -> Document | None:
        result = await super().get_document(path)
        if result is not None and len(result.bytes_contents) > MAX_LOCAL_INLINE_BYTES:
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_DOCUMENT_EXCEEDS_LOCAL_INLINE_LIMIT"
            )
        return result

    def text_document_from(self, src: Any) -> TextDocument:
        if len(src.bytes_contents) > MAX_LOCAL_INLINE_BYTES:
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_RESTORED_TEXT_TOO_LARGE_FOR_LOCAL_CONTEXT"
            )
        return super().text_document_from(src)

    async def document_from(self, src: Uploadable) -> Document:
        if len(src.bytes_contents) > MAX_LOCAL_INLINE_BYTES:
            raise LocalMiMoDocumentUnsupported(
                "LOCAL_MIMO_RESTORED_DOCUMENT_EXCEEDS_INLINE_LIMIT"
            )
        return await super().document_from(src)


class LocalMiMoService(ProviderServiceBase):
    """Original Composer memory and retry contracts, no remote model APIs."""

    def __init__(self) -> None:
        # Original Composer's OpenAI tool schema is closest to llama-server's
        # Chat Completions interface; correctness of native tool calls remains
        # explicitly UNVERIFIED until actual G6 tool/memory qualification.
        from graphcore.tools.memory import openai_async_memory_tool

        super().__init__(openai_async_memory_tool, LocalMiMoUploader)

    def should_retry(self, exc: Exception) -> bool:
        # Transport/temporary HTTP failures only; never retry a model schema,
        # unsupported PDF, prompt-budget, missing role or native CVL error.
        if isinstance(exc, (httpx.TransportError, openai.APIConnectionError)):
            return True
        if isinstance(exc, openai.APIStatusError):
            return exc.status_code in (408, 409, 429) or exc.status_code >= 500
        return False


def _zero_cost_local_model(_: int) -> PriceTier:
    """Local inference has no provider-token charge (runner usage is separate)."""
    return PriceTier(
        input=0.0, output=0.0, cache_read=0.0,
        cache_write=0.0, cache_write_1h=0.0
    )


@dataclass
class LocalMiMoModelProvider:
    """Original ModelProvider fields for a single, fixed MiMo alias."""

    model_name: str
    options: ModelConfiguration
    provider: LocalMiMoService = field(default_factory=LocalMiMoService)

    @staticmethod
    def create(model_name: str, options: ModelConfiguration) -> LocalMiMoModelProvider:
        if model_name != MODEL_ALIAS:
            raise ValueError("LOCAL_MIMO_UNTRUSTED_MODEL_ALIAS")
        return LocalMiMoModelProvider(model_name=model_name, options=options)

    @property
    def price_provider(self) -> PriceProvider:
        return _zero_cost_local_model

    @property
    def max_prompt_tokens(self) -> int:
        return compaction_threshold(CONTEXT_WINDOW)

    def builder_for(
        self, *, cache_level: CacheLevel = CacheLevel.NONE,
        disable_thinking: bool = False
    ):
        # The model is job-local, reached through an immutable loopback address.
        # Do not use OpenAI Responses, remote Files API, endpoint env overrides,
        # tool-call fallback to external providers or hidden reasoning params.
        from langchain_openai import ChatOpenAI

        token_cap = min(MAX_COMPLETION_TOKENS, int(self.options.tokens))
        if token_cap < 1:
            raise ValueError("LOCAL_MIMO_OUTPUT_TOKEN_BUDGET_INVALID")
        return ChatOpenAI(
            model=MODEL_ALIAS,
            base_url=LOCAL_BASE_URL,
            api_key="local-loopback-no-credential",
            use_responses_api=False,
            max_completion_tokens=token_cap,
            timeout=120,
            max_retries=1,
            temperature=0.1,
            callbacks=standard_callbacks(self.price_provider),
        )


LOCAL_MIMO_SPEC = ProviderSpec(
    matches=lambda name: name == MODEL_ALIAS,
    build=LocalMiMoModelProvider.create,
)
