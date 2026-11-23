"""Single local MiMo provider for Certora AutoProver's pinned entry-point registry.

This provider is inert until the trusted GitHub formal job supplies the
Tailscale-verified IPv4 address. No model API request is made by import,
entry-point lookup or adapter construction; live inference is I05.2.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
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


class MiMoProtocolError(ValueError):
    """Invalid local model transport/JSON/tool envelope; never an accepted answer."""


def validate_mimo_chat_completion(body: dict, request: dict) -> None:
    """Validate the native chat-completions envelope before AutoProver can use it.

    Only AutoProver can execute tools. A model tool call is not evidence of
    execution; its name must have been offered in the exact originating request.
    Pydantic validates each structured *schema* after this transport check.
    """
    if not isinstance(body, dict) or not isinstance(request, dict):
        raise MiMoProtocolError("MiMo completion/request is not JSON object")
    if request.get("model") != MODEL_ID or body.get("model") != MODEL_ID:
        raise MiMoProtocolError("MiMo completion model identity mismatch")
    choices = body.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        raise MiMoProtocolError("Expected exactly one local completion choice")
    choice = choices[0]
    if not isinstance(choice, dict) or choice.get("finish_reason") in ("length", "content_filter"):
        raise MiMoProtocolError("MiMo completion truncated or filtered")
    msg = choice.get("message")
    if not isinstance(msg, dict) or msg.get("role") != "assistant":
        raise MiMoProtocolError("Invalid local assistant message")
    offered = set()
    for tool in request.get("tools") or []:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            raise MiMoProtocolError("Unknown requested tool type")
        fn = tool.get("function")
        if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
            raise MiMoProtocolError("Invalid offered tool declaration")
        offered.add(fn["name"])
    raw_calls = msg.get("tool_calls") or []
    if not isinstance(raw_calls, list):
        raise MiMoProtocolError("MiMo tool_calls must be a list")
    seen_ids: set[str] = set()
    for call in raw_calls:
        if not isinstance(call, dict) or call.get("type") != "function":
            raise MiMoProtocolError("Unexpected tool-call envelope")
        call_id = call.get("id")
        fn = call.get("function")
        if (not isinstance(call_id, str) or not call_id or call_id in seen_ids
                or not isinstance(fn, dict) or fn.get("name") not in offered
                or not isinstance(fn.get("arguments"), str)):
            raise MiMoProtocolError("Unknown, duplicated, or malformed MiMo tool call")
        seen_ids.add(call_id)
        try:
            args = json.loads(fn["arguments"])
        except json.JSONDecodeError as exc:
            raise MiMoProtocolError("MiMo tool arguments are not JSON") from exc
        if not isinstance(args, dict):
            raise MiMoProtocolError("MiMo function arguments must be a JSON object")
    if raw_calls and request.get("tool_choice") == "none":
        raise MiMoProtocolError("Model invoked tools explicitly prohibited by AutoProver")
    content = msg.get("content")
    if not raw_calls and (not isinstance(content, str) or not content.strip()):
        raise MiMoProtocolError("MiMo returned no textual answer or tool calls")
    fmt = request.get("response_format")
    if isinstance(fmt, dict) and fmt.get("type") == "json_schema":
        if raw_calls or not isinstance(content, str):
            raise MiMoProtocolError("Schema-directed MiMo reply is not JSON text")
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise MiMoProtocolError("Schema-directed MiMo response is not valid JSON") from exc
        if not isinstance(parsed, dict):
            raise MiMoProtocolError("Schema-directed MiMo output must be a JSON object")


def _check_local_response(response: httpx.Response) -> None:
    if response.status_code >= 400:
        return  # The upstream SDK handles network/status failures.
    req = response.request
    if req.url.path != "/v1/chat/completions":
        raise MiMoProtocolError("Unexpected model API path")
    try:
        request_json = json.loads(req.content)
        response_json = response.json()
    except (ValueError, TypeError) as exc:
        raise MiMoProtocolError("Local completion is not JSON") from exc
    validate_mimo_chat_completion(response_json, request_json)


def _sync_local_response(response: httpx.Response) -> None:
    response.read()
    _check_local_response(response)


async def _async_local_response(response: httpx.Response) -> None:
    await response.aread()
    _check_local_response(response)


def _trusted_http_client() -> httpx.Client:
    return httpx.Client(
        trust_env=False,
        event_hooks={"response": [_sync_local_response]},
    )


def _trusted_async_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        trust_env=False,
        event_hooks={"response": [_async_local_response]},
    )


def mimo_autoprover_model_args() -> list[str]:
    """Pass the actual upstream AutoProver CLI both model roles; no fallback."""
    return [
        "--heavy-model", MODEL_ID,
        "--lite-model", MODEL_ID,
    ]


def configure_local_mimo_runtime() -> dict[str, str]:
    """Wire AutoSetup to the same verified MiMo and prohibit schema fallbacks.

    Call before importing AutoProver's CLI in the formal job. Patches *only*
    live in this Python process; pinned upstream files are never modified.
    No local/private endpoint implies immediate failure, not cloud fallback.
    """
    base_url = _private_chat_completions_base_url()
    forbidden = (
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
        "CERTORAKEY", "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    )
    if any(os.environ.get(key) for key in forbidden):
        raise RuntimeError("Unexpected cloud/paid inference credentials in MiMo execution")
    os.environ["PREAUDIT_LLM_BACKEND"] = "local"
    os.environ["PREAUDIT_LOCAL_LLM_BASE_URL"] = base_url
    os.environ["PREAUDIT_LOCAL_LLM_MODEL"] = MODEL_ID

    import certora_autosetup.utils.llm_util as llm

    if llm._get_backend().value != "local":
        raise RuntimeError("Upstream AutoSetup did not select the local backend")
    if getattr(llm, "_curveyield_mimo_strict", False):
        return {
            "backend": "local", "base_url": base_url, "model": MODEL_ID,
        }

    @cache
    def _local_sync():
        real = openai.OpenAI(
            base_url=base_url, api_key="local-network-only",
            http_client=_trusted_http_client(), timeout=900.0,
        )
        return llm._UsageRecordingOpenAI(real, is_async=False)

    @cache
    def _local_async():
        real = openai.AsyncOpenAI(
            base_url=base_url, api_key="local-network-only",
            http_client=_trusted_async_http_client(), timeout=900.0,
        )
        return llm._UsageRecordingOpenAI(real, is_async=True)

    def _strict_sync(
        client, model, messages, max_tokens, temperature, output_type,
        max_retries, verbose, on_usage=None,
    ):
        if model != MODEL_ID:
            raise RuntimeError("AutoSetup attempted to use a non-MiMo model")
        response = llm._local_retry_transient(
            lambda: client.chat.completions.create(
                model=MODEL_ID, messages=messages,
                max_tokens=max_tokens, temperature=temperature,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "output", "strict": True,
                        "schema": output_type.model_json_schema(),
                    },
                },
            ),
            max_retries, verbose,
        )
        llm._emit_openai_usage(response, on_usage)
        # Model JSON schema is validated by Pydantic; a bad output fails closed.
        # Upstream's prompt-based fallback is deliberately not invoked.
        return output_type.model_validate_json(response.choices[0].message.content)

    async def _strict_async(
        client, model, messages, max_tokens, temperature, output_type,
        max_retries, verbose, on_usage=None,
    ):
        if model != MODEL_ID:
            raise RuntimeError("AutoSetup attempted to use a non-MiMo model")
        response = await llm._local_retry_transient_async(
            lambda: client.chat.completions.create(
                model=MODEL_ID, messages=messages,
                max_tokens=max_tokens, temperature=temperature,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "output", "strict": True,
                        "schema": output_type.model_json_schema(),
                    },
                },
            ),
            max_retries, verbose,
        )
        llm._emit_openai_usage(response, on_usage)
        return output_type.model_validate_json(response.choices[0].message.content)

    llm._init_local_client = _local_sync
    llm._init_async_local_client = _local_async
    llm._local_call_structured = _strict_sync
    llm._local_call_structured_async = _strict_async
    llm._curveyield_mimo_strict = True
    return {
        "backend": "local", "base_url": base_url, "model": MODEL_ID,
    }


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
        if isinstance(exc, MiMoProtocolError):
            return True  # Existing graphcore bounded retry policy; no fake success.
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
            timeout=900.0,
            max_retries=2,
            streaming=False,
            disable_streaming=True,
            # Ignore ambient HTTP(S)_PROXY and other inherited proxy settings.
            http_client=_trusted_http_client(),
            http_async_client=_trusted_async_http_client(),
            callbacks=standard_callbacks(self.price_provider),
        )


MIMO_SPEC = ProviderSpec(
    matches=lambda name: name == MODEL_ID,
    build=MiMoModelProvider.create,
)
