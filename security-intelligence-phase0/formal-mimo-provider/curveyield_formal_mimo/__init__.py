"""Single local MiMo provider for Certora AutoProver's pinned entry-point registry.

This provider is inert until the trusted GitHub formal job supplies the
Tailscale-verified IPv4 address. No model API request is made by import,
entry-point lookup or adapter construction; live inference is I05.2.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import cache
from ipaddress import IPv4Address, IPv4Network
import os
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import httpx
import openai
from pydantic import SecretStr

from composer.input.files import (
    ContentRenderer, Document, FileData, InMemoryBytesFile,
    InMemoryTextFile, TextDocument, UploaderBase,
)
from composer.input.types import ModelConfiguration
from composer.llm.provider import (
    ProviderServiceBase, ProviderSpec, PriceProvider,
    compaction_threshold, payload_error_type, standard_callbacks,
)
from composer.llm.types import CacheLevel

if TYPE_CHECKING:
    from langchain_core.language_models.chat_models import BaseChatModel

MODEL_ID = "lite-solo-mimo-v1"
TAILNET = IPv4Network("100.64.0.0/10")
# The current pinned certora_qa llama-server command specifies --ctx-size 262144.
# The upstream compaction policy reserves half the total context.
MIMO_CONTEXT_SIZE = 262144


def _private_chat_completions_base_url() -> str:
    """Validate the exact URL against the IP supplied by trusted Tailscale setup.

    The formal job must obtain CURVEYIELD_MIMO_VERIFIED_TAILNET_IP from the
    matched certora_qa rendezvous and authenticate network membership at I05.2.
    This function checks URL structure and address class; it cannot prove that
    an actual remote peer is online. Never accept arbitrary hostnames or proxy URLs.
    """
    verified_ip = os.environ.get("CURVEYIELD_MIMO_VERIFIED_TAILNET_IP", "")
    supplied = os.environ.get("CURVEYIELD_MIMO_BASE_URL", "")
    if not verified_ip or not supplied:
        raise RuntimeError("Verified private MiMo endpoint not yet established")
    try:
        ip = IPv4Address(verified_ip)
    except ValueError as exc:
        raise RuntimeError("MiMo rendezvous must provide a canonical IPv4 address") from exc
    if ip not in TAILNET or str(ip) != verified_ip:
        raise RuntimeError("MiMo destination is not a canonical Tailscale IPv4 address")
    parsed = urlsplit(supplied)
    if (parsed.scheme != "http" or parsed.netloc != f"{ip}:8080"
            or parsed.path != "/v1" or parsed.query or parsed.fragment
            or parsed.username is not None or parsed.password is not None):
        raise RuntimeError("MiMo destination is not the matched private /v1 endpoint")
    return f"http://{ip}:8080/v1"


class MiMoInlineRenderer:
    """Chat-completions text blocks; never call a provider Files API."""

    def text_block(self, text: str, *, cache_level: CacheLevel = CacheLevel.NONE) -> dict:
        return {"type": "text", "text": text}

    def file_block(self, file_id: str, *, cache_level: CacheLevel = CacheLevel.NONE) -> dict:
        raise RuntimeError("MiMo has no remote Files API; file IDs are not accepted")

    def inline_file_block(
        self, basename: str, contents: bytes, mime: str,
        *, cache_level: CacheLevel = CacheLevel.NONE,
    ) -> dict:
        # This pinned GGUF is text-only; sending PDF/image data URIs would
        # pretend it has an OCR/multimodal tool that has not been installed.
        try:
            text = contents.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(
                "MiMo cannot read binary files: extract their text locally first"
            ) from exc
        return {
            "type": "text",
            "text": f"[Local file: {basename}; MIME: {mime}]\n{text}\n[/Local file]",
        }


@dataclass
class MiMoInlineUploader(UploaderBase):
    renderer: ContentRenderer = field(default_factory=MiMoInlineRenderer)

    async def _upload_bytes(self, crc_basename: str, file_data: bytes, mime: str) -> str:
        raise RuntimeError("MiMo file upload is forbidden; use inline local content")

    async def _binary_document(self, data: FileData) -> Document:
        # Content is rendered inline on consumption, never sent elsewhere.
        return InMemoryBytesFile(
            basename=data.basename, contents=data.raw_data,
            mime=data.mime, renderer=self.renderer,
        )

    async def _text_upload_document(self, data: FileData) -> TextDocument:
        return InMemoryTextFile(
            basename=data.basename, string_contents=data.raw_data.decode("utf-8"),
            renderer=self.renderer,
        )


class MiMoService(ProviderServiceBase):
    """Use AutoProver's own local memory/tool execution authority."""

    def __init__(self) -> None:
        from graphcore.tools.memory import openai_async_memory_tool
        super().__init__(openai_async_memory_tool, MiMoInlineUploader)

    def should_retry(self, exc: Exception) -> bool:
        # Never retry semantic/schema errors as though they were transient.
        if isinstance(exc, (httpx.TransportError, TimeoutError, openai.APIConnectionError)):
            return True
        if isinstance(exc, openai.APIStatusError):
            if exc.status_code in (408, 409, 429) or exc.status_code >= 500:
                return True
            return payload_error_type(exc.body) in {"server_error", "rate_limit_exceeded"}
        return False


@cache
def _mimo_service() -> MiMoService:
    return MiMoService()


def _local_price(_input_tokens: int):
    # The user's existing self-hosted MiMo instance is not a paid model API.
    return None


@dataclass
class MiMoModelProvider:
    model_name: str
    options: ModelConfiguration
    price_provider: PriceProvider = _local_price
    provider: MiMoService = field(default_factory=_mimo_service)

    @staticmethod
    def create(model_name: str, options: ModelConfiguration) -> MiMoModelProvider:
        if model_name != MODEL_ID:
            raise ValueError("Only pinned local MiMo model is supported")
        return MiMoModelProvider(model_name=model_name, options=options)

    @property
    def max_prompt_tokens(self) -> int:
        return compaction_threshold(MIMO_CONTEXT_SIZE)

    def builder_for(
        self, *, cache_level: CacheLevel = CacheLevel.NONE,
        disable_thinking: bool = False,
    ) -> BaseChatModel:
        from langchain_openai import ChatOpenAI

        # This check must run at each model construction; no default/public
        # endpoint, OpenAI-style model guessing, env API key or cloud fallback.
        private_url = _private_chat_completions_base_url()
        return ChatOpenAI(
            model=self.model_name,
            base_url=private_url,
            api_key=SecretStr("local-network-only"),
            use_responses_api=False,
            max_tokens=self.options.tokens,
            timeout=300.0,
            max_retries=2,
            streaming=True,
            # Ignore ambient HTTP(S)_PROXY and other inherited proxy settings.
            http_client=httpx.Client(trust_env=False),
            http_async_client=httpx.AsyncClient(trust_env=False),
            callbacks=standard_callbacks(self.price_provider),
        )


MIMO_SPEC = ProviderSpec(
    matches=lambda name: name == MODEL_ID,
    build=MiMoModelProvider.create,
)
