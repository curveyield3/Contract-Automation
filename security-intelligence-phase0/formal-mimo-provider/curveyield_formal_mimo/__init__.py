"""Single local MiMo provider for Certora AutoProver's pinned entry-point registry.

This provider is inert until the trusted GitHub formal job supplies the
Tailscale-verified IPv4 address. No model API request is made by import,
entry-point lookup or adapter construction; live inference is I05.2.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import itertools
import json
import re
from functools import cache, wraps
from pathlib import Path
import time
import sys
import threading
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



# Source-locked, explicit public DAI integration tracing. This never records
# authorization headers, endpoint credentials, or non-DAI campaign payloads.
_TRACE_LOCK = threading.RLock()
_TRACE_SEQUENCE = itertools.count(1)
_RETRY_HINTS: dict[str, str] = {}


def _trace_enabled() -> bool:
    return os.environ.get("CURVEYIELD_PUBLIC_DAI_WIRE_TRACE") == "1"


def _append_observation(event: dict, path_variable: str) -> bool:
    """Write a complete record directly to private scratch, not mixed stdout.
    Observer failures cannot abort the underlying native inference request.
    """
    try:
        path = os.environ[path_variable]
        record = {**event, "targetIndex": int(os.environ["CURVEYIELD_FORMAL_TARGET_INDEX"]),
                  "producerPid": os.getpid()}
        raw = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        with _TRACE_LOCK:
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC)
            try:
                if os.write(fd, raw) != len(raw):
                    os.write(fd, b"\n")
                    raise OSError("short observation write")
            finally:
                os.close(fd)
        return True
    except (OSError, ValueError, KeyError, TypeError) as exc:
        try:
            print("CURVEYIELD_OBSERVATION_WARNING " + json.dumps({
                "event": "OBSERVATION_WRITE_FAILED", "channel": path_variable,
                "exceptionType": type(exc).__name__, "requestNumber": event.get("requestNumber"),
            }, separators=(",", ":")), file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass
        return False


def _wire_event(event: dict) -> bool:
    if not _trace_enabled():
        return True
    return _append_observation(event, "CURVEYIELD_DAI_WIRE_PATH")


def _wire_body(direction: str, request_number: int, raw: bytes,
               status: int | None = None) -> None:
    """Capture the exact body in one record; no mixed-log chunk reassembly."""
    if not _trace_enabled():
        return
    try:
        payload = raw.decode("utf-8", "strict")
        encoding = "utf-8"
    except UnicodeDecodeError:
        import base64
        payload = base64.b64encode(raw).decode("ascii")
        encoding = "base64"
    _wire_event({"event": "COMPLETE_BODY", "requestNumber": request_number,
                 "direction": direction, "encoding": encoding, "chunkCount": 1,
                 "byteCount": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                 "httpStatus": status, "payload": payload})


def _log_request(request: httpx.Request) -> None:
    if not _trace_enabled() or request.url.path != "/v1/chat/completions":
        return
    number = next(_TRACE_SEQUENCE)
    request.extensions["curveyield_dai_wire_number"] = number
    _wire_body("AUTOPROVER_TO_MIMO", number, request.content)


async def _log_request_async(request: httpx.Request) -> None:
    _log_request(request)


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
    choice_rule = request.get("tool_choice")
    if choice_rule == "required" and not raw_calls:
        raise MiMoProtocolError("MiMo omitted a required tool call")
    if isinstance(choice_rule, dict) and choice_rule.get("type") == "function":
        required_name = (choice_rule.get("function") or {}).get("name")
        if not raw_calls or any(c["function"]["name"] != required_name for c in raw_calls):
            raise MiMoProtocolError("MiMo omitted the specified required tool call")
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


def _observe_response(response: httpx.Response) -> None:
    if _trace_enabled() and response.request.url.path == "/v1/chat/completions":
        number = response.request.extensions.get("curveyield_dai_wire_number")
        if not isinstance(number, int):
            raise MiMoProtocolError("DAI wire trace lost request correlation")
        _wire_body("MIMO_TO_AUTOPROVER", number, response.content,
                   status=response.status_code)
    try:
        _check_local_response(response)
    except Exception as exc:
        _wire_event({"event": "RESPONSE_VALIDATION", "requestNumber":
                     response.request.extensions.get("curveyield_dai_wire_number"),
                     "outcome": "REJECTED", "exceptionType": type(exc).__name__,
                     "reason": str(exc) if isinstance(exc, MiMoProtocolError) else
                     "model response verification exception"})
        raise
    _wire_event({"event": "RESPONSE_VALIDATION", "requestNumber":
                 response.request.extensions.get("curveyield_dai_wire_number"),
                 "outcome": "ENVELOPE_ACCEPTED" if response.status_code < 400 else
                 "HTTP_STATUS_REJECTED_BY_SDK",
                 "httpStatus": response.status_code})


def _sync_local_response(response: httpx.Response) -> None:
    response.read()
    _observe_response(response)


async def _async_local_response(response: httpx.Response) -> None:
    await response.aread()
    _observe_response(response)



# Only the authenticated native execution sets the project root. The existing
# I05.2 handshake retains its exact previously qualified non-stream protocol.
_PROGRESS_PREFIX = "CURVEYIELD_MIMO_PROGRESS_V1 "
_PROGRESS_SEQUENCE = _TRACE_SEQUENCE


def _progress_event(event: dict) -> None:
    if os.environ.get("CURVEYIELD_FORMAL_PROJECT_ROOT"):
        if not _append_observation(event, "CURVEYIELD_FORMAL_PROGRESS_PATH"):
            try:
                print(_PROGRESS_PREFIX + json.dumps(event, separators=(",", ":")),
                      file=sys.stderr, flush=True)
            except (OSError, ValueError):
                pass


@cache
def _analysis_source_context(root_name: str) -> tuple[str, bool]:
    """Inline small authenticated Solidity trees; larger trees retain retrieval.
    The threshold is a transport optimization, not a source or coverage limit.
    """
    root = Path(root_name).resolve(strict=True)
    paths = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs
                         if d not in {".git", ".certora_internal", "out", "cache", "node_modules"}
                         and not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if (path.suffix == ".sol" and not path.is_symlink()
                    and path.is_file() and path.resolve().is_relative_to(root)):
                paths.append(path)
    paths.sort(key=lambda p: p.relative_to(root).as_posix())
    inventory = "Authenticated Solidity source inventory:\n" + "\n".join(
        p.relative_to(root).as_posix() for p in paths)
    if not paths or sum(p.stat().st_size for p in paths) > 32768:
        return inventory, False
    contents = [inventory]
    for path in paths:
        contents.extend(["\n[Source: " + path.relative_to(root).as_posix() + "]\n",
                         path.read_text(encoding="utf-8"), "\n[/Source]\n"])
    return "".join(contents), True


def _compact_schema(value):
    # Remove schema display titles, not property names, types, constraints,
    # descriptions, required fields, or discriminated union definitions.
    if isinstance(value, list):
        return [_compact_schema(v) for v in value]
    if not isinstance(value, dict):
        return value
    return {k: ({name: _compact_schema(schema) for name, schema in v.items()}
                if k in ("properties", "$defs", "definitions", "patternProperties")
                and isinstance(v, dict) else _compact_schema(v))
            for k, v in value.items() if k != "title"}


def _prepare_native_payload(payload: dict) -> tuple[dict, str]:
    """Narrow prompt adaptation; the native graph and result validators remain
    authoritative. No fabricated tool output or preaccepted model results.
    """
    root = os.environ.get("CURVEYIELD_FORMAL_PROJECT_ROOT")
    if not root:
        return payload, "native"
    payload = dict(payload)
    payload["cache_prompt"] = True
    messages = payload.get("messages") or []
    tools = payload.get("tools") or []
    names = {t.get("function", {}).get("name") for t in tools if isinstance(t, dict)}
    result = next((t["function"] for t in tools
                   if t.get("function", {}).get("name") == "result"), {})
    fields = result.get("parameters", {}).get("properties", {})
    system = messages[0].get("content", "") if messages else ""
    is_analysis = (
        isinstance(system, str) and "experienced system architect" in system
        and {"application_type", "description", "components"}.issubset(fields)
        and len(messages) >= 2 and messages[0].get("role") == "system"
        and messages[1].get("role") == "user"
        and "get_file" in names
    )
    if not is_analysis:
        if "items" in fields and "result" in names and isinstance(system, str) and messages:
            messages = [dict(m) for m in messages]
            messages[0]["content"] += (
                "\nSubmit distinct, source-supported items only. Do not repeat the same "
                "property or attack description under different numbered titles. "
                "Use the native result schema and the required tool."
            )
            payload["messages"] = messages
        return payload, "native"
    original_user = messages[1].get("content")
    if not isinstance(original_user, list) or not original_user:
        return payload, "native"
    first = original_user[0]
    if not isinstance(first, dict) or first.get("type") != "text":
        return payload, "native"
    if "extract a holistic, structured description" not in first.get("text", ""):
        return payload, "native"
    evidence, complete = _analysis_source_context(root)
    messages = [dict(m) for m in messages]
    messages[0]["content"] = (
        "Analyze the authenticated Solidity implementation and any supplied design document. "
        "Use the native result tool to submit a complete structured application model. "
        "Ground claims in evidence; use exact Solidity identifiers and project-relative paths. "
        "Do not invent design intent. Use retrieval only when necessary. "
        "Record memory only when useful; do not write or reread a ceremonial draft. "
        "Review the result for completeness before submitting."
    )
    task = (
        "Classify the application and describe it in 2–3 sentences. Enumerate explicit contracts "
        "and external actors transitively, stopping at external-actor boundaries. "
        "For each contract give conceptual name, exact Solidity identifier, relative source path, "
        "description, and deployment sort: singleton (one instance), dynamic (created by the "
        "application), multiple (externally deployed instances). For each functional component "
        "describe its behavior, external entry points, state variables, requirements and "
        "interactions using the declared contract/component/actor names. Include known standard "
        "interfaces and their entry points. For external actors state role, evidence-supported "
        "assumptions and interface path if available, otherwise null. A single in-tree "
        "implementation of an interface is an explicit contract; generic standards allowing "
        "arbitrary implementations are external actors; domain-specific interfaces with in-tree "
        "implementations are explicit components. If multiple implementations exist, identify "
        "the external interface actor and its explicit implementations. Do not hypothesize beyond "
        "external actors or present pseudocode. The required main entry point must be included. "
        "Submit the complete result directly, using the provided native result schema."
    )
    if complete:
        task += " All authenticated Solidity files are supplied below; do not rediscover them."
    else:
        task += " Use get_file or grep_files for relevant missing source; delegate only genuinely broad exploration."
    messages[1]["content"] = [{"type": "text", "text": task},
                              *original_user[1:],
                              {"type": "text", "text": evidence}]
    omit = {"write_rough_draft", "read_rough_draft"}
    if complete:
        # Diagnostic rule (DAI r10/r11): examine the actual transmitted prompt,
        # actual model-generated content and native result schema/validator feedback
        # FIRST. Token counters, heartbeats, successful HTTP transport and reasoning
        # volume do not demonstrate meaningful result progress. Do not wait for
        # repeated operator requests before comparing the exact three surfaces.
        # A generation constraint alone need not make the schema visible to the
        # model. Supply the same original schema in both the prompt and API.
        # Keep substantive reasoning available; do not invent a response limit.
        messages[0]["content"] = (
            "Analyze the authenticated Solidity implementation and any supplied design document. "
            "Return exactly one JSON object conforming to the supplied result schema. "
            "Do not write Markdown or a tool-call wrapper. Ground claims in the source; "
            "check each function's actual modifiers, state mutations and authorization. "
            "Distinguish external actors from EVM primitives and internal inheritance. "
            "Use exact source identifiers and project-relative paths. Do not invent design "
            "requirements, guarantees, actors or interactions. The JSON Schema below is the "
            "authoritative output contract. Follow its exact property names, nesting, required "
            "fields, enums and types; do not design an alternative structure. Use empty arrays "
            "where evidence supports no entries and null only where the schema permits it. "
            "Do not add fields outside the schema. The compiler-derived callable/modifier rows "
            "and exact source excerpts are authoritative observations. In requirements about authorization "
            "or logging, preserve the exact applied modifier list and source assignment indices; "
            "do not infer modifiers from names or assume that every function uses a common modifier. "
            "Distinguish modifier checks from conditional checks inside function bodies. "
            "An inherited implementation is not a separately deployed actor. State only supported "
            "requirements and use source identifiers or exact expressions rather than speculative "
            "generalizations. Review source facts, then emit the JSON directly."
        )
        # Serialize the complete native schema once; reuse that object for constrained
        # sampling. No hand-maintained approximation of the result structure.
        result_schema = result["parameters"]
        messages[1]["content"][0]["text"] = task.replace(
            "Submit the complete result directly, using the provided native result schema.",
            "Return the complete application model as a JSON object matching the supplied schema."
        )
        messages[1]["content"].insert(1, {
            "type": "text",
            "text": "EXACT NATIVE AUTOPROVER RESULT JSON SCHEMA:\n"
                    + json.dumps(result_schema, ensure_ascii=False, separators=(",", ":")),
        })
        # Put the existing source-bound context document after the complete
        # source, making exact compiler observations the last evidence before
        # the response. Keep the native entry-point instruction unchanged.
        blocks = messages[1]["content"]
        source_block = blocks.pop()
        blocks.insert(2, source_block)
        # Native validation errors arrive as tool messages. Present the actual
        # prior model JSON and exact validator feedback as conversational text,
        # since this schema-only API request offers no executable tools.
        history = messages[:2]
        for m in messages[2:]:
            if m.get("role") == "assistant" and m.get("tool_calls"):
                previous = []
                for c in m["tool_calls"]:
                    fn = c.get("function") or {}
                    previous.append({"name": fn.get("name"), "arguments": fn.get("arguments")})
                history.append({"role": "assistant", "content":
                                json.dumps(previous, ensure_ascii=False)})
            elif m.get("role") == "tool":
                history.append({"role": "user", "content":
                                "Native AutoProver tool feedback (correct any reported errors):\n"
                                + (m["content"] if isinstance(m.get("content"), str)
                                   else json.dumps(m.get("content"), ensure_ascii=False))})
            else:
                history.append(m)
        payload["messages"] = history
        payload.pop("tools", None)
        payload.pop("parallel_tool_calls", None)
        payload["tool_choice"] = "none"
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "result", "strict": True,
                            "schema": result_schema},
        }
        payload["chat_template_kwargs"] = {
            **(payload.get("chat_template_kwargs") or {}), "enable_thinking": True}
        payload.pop("reasoning_effort", None)
        return payload, "component_analysis_schema"
    # Keep any tools already used in the conversation so a retry remains
    # protocol-compatible with its historical tool calls.
    used = {c.get("function", {}).get("name") for m in messages
            for c in (m.get("tool_calls") or [])}
    payload["messages"] = messages
    payload["tools"] = [
        {**t, "function": {**t["function"],
                            "parameters": _compact_schema(t["function"].get("parameters", {}))}}
        for t in tools if t["function"]["name"] not in omit - used
    ]
    return payload, "component_analysis_retrieval"


class _NativeStream:
    """Aggregate the pinned llama.cpp chat-completion SSE protocol into the
    exact normal OpenAI completion shape expected by the qualified SDK.
    No tool is delivered to AutoProver before full envelope validation.
    """
    def __init__(self, number: int, mode: str, request: dict, request_key: str):
        self.number, self.mode, self.request = number, mode, request
        self.request_key = request_key
        self.wire_complete = False
        self.content, self.reasoning = [], []
        self.calls = {}
        self.meta, self.usage, self.timings, self.prompt = {}, {}, {}, {}
        self.finish_reason = None
        self.done = False
        self.last_report = time.monotonic()
        self.wire = bytearray()
        self.pending = b""
        self.stream_offset = 0
        self.last_published = 0

    def feed(self, chunk: bytes):
        self.wire.extend(chunk)
        data = self.pending + chunk
        lines = data.split(b"\n")
        self.pending = lines.pop()
        for line in lines:
            line = line.rstrip(b"\r")
            if not line.startswith(b"data:"):
                continue
            body = line[5:].strip()
            if body == b"[DONE]":
                self.done = True
                continue
            event = json.loads(body)
            if not isinstance(event, dict) or "error" in event:
                raise MiMoProtocolError("MiMo returned an SSE error")
            if event.get("model", MODEL_ID) != MODEL_ID:
                raise MiMoProtocolError("MiMo stream model identity mismatch")
            for k in ("id", "created", "model", "system_fingerprint"):
                if k in event:
                    self.meta[k] = event[k]
            for k, dest in (("usage", self.usage), ("timings", self.timings),
                            ("prompt_progress", self.prompt)):
                if isinstance(event.get(k), dict):
                    dest.update(event[k])
            for choice in event.get("choices") or []:
                if choice.get("index") != 0:
                    raise MiMoProtocolError("Unexpected MiMo stream choice index")
                delta = choice.get("delta") or {}
                if delta.get("role", "assistant") != "assistant":
                    raise MiMoProtocolError("Unexpected MiMo stream role")
                if isinstance(delta.get("content"), str):
                    self.content.append(delta["content"])
                if isinstance(delta.get("reasoning_content"), str):
                    self.reasoning.append(delta["reasoning_content"])
                for call in delta.get("tool_calls") or []:
                    idx = call.get("index")
                    if not isinstance(idx, int) or idx < 0:
                        raise MiMoProtocolError("MiMo stream tool index missing")
                    item = self.calls.setdefault(idx, {"type": "function", "id": "",
                                                       "function": {"name": "", "arguments": ""}})
                    if call.get("type", "function") != "function":
                        raise MiMoProtocolError("Unexpected MiMo stream tool type")
                    if call.get("id"):
                        if item["id"] and item["id"] != call["id"]:
                            raise MiMoProtocolError("MiMo stream tool identity changed")
                        item["id"] = call["id"]
                    fn = call.get("function") or {}
                    if fn.get("name"):
                        item["function"]["name"] += fn["name"]
                    if isinstance(fn.get("arguments"), str):
                        item["function"]["arguments"] += fn["arguments"]
                if choice.get("finish_reason") is not None:
                    self.finish_reason = choice["finish_reason"]
        if time.monotonic() - self.last_report >= 15:
            self.report()
            self._reject_repetition()

    def _reject_repetition(self):
        # r13 request 17 repeated identical attack-vector descriptions under
        # numbered titles for 78 minutes. Do not reject slow or long answers.
        fields = next((t.get("function", {}).get("parameters", {}).get("properties", {})
                       for t in self.request.get("tools") or []
                       if t.get("function", {}).get("name") == "result"), {})
        if "items" in fields:
            for call in self.calls.values():
                fn = call["function"]
                if fn["name"] != "result":
                    continue
                previous, repeats = None, 0
                for match in re.finditer(r'"description"\s*:\s*("(?:\\.|[^"\\])*")',
                                         fn["arguments"]):
                    try:
                        value = " ".join(json.loads(match.group(1)).split()).casefold()
                    except (ValueError, TypeError):
                        continue
                    repeats = repeats + 1 if value == previous and len(value) >= 40 else 1
                    previous = value
                    if repeats >= 4:
                        raise MiMoProtocolError("MiMo repeated identical property descriptions")
        for parts in (self.reasoning, self.content):
            previous, repeats = None, 0
            for line in "".join(parts).splitlines():
                value = " ".join(line.split())
                if not value:
                    continue
                repeats = repeats + 1 if value == previous and len(value) >= 80 else 1
                previous = value
                if repeats >= 4:
                    raise MiMoProtocolError("MiMo repeated identical generated paragraphs")

    def failed(self, exc: Exception):
        self.report()
        if not self.wire_complete:
            _wire_event({"event": "STREAM_ABORTED", "requestNumber": self.number,
                         "direction": "MIMO_TO_AUTOPROVER", "byteCount": len(self.wire),
                         "sha256": hashlib.sha256(self.wire).hexdigest(),
                         "exceptionType": type(exc).__name__})
        if isinstance(exc, MiMoProtocolError):
            message = str(exc)
            if "repeated identical" in message or "truncated or filtered" in message:
                hint = ("The previous attempt repeated entries or reached the output limit. "
                        "Submit only distinct, source-supported claims. Do not repeat descriptions "
                        "with numbered titles, and do not omit required schema fields.")
            elif "required tool call" in message:
                hint = ("The previous answer omitted the required tool call. Use the exact "
                        "offered tool and its declared argument schema; do not return prose instead.")
            else:
                hint = ("The previous response failed native transport or tool-envelope validation. "
                        "Return a complete valid response using the exact supplied tool/schema.")
            with _TRACE_LOCK:
                _RETRY_HINTS[self.request_key] = hint
                if len(_RETRY_HINTS) > 64:
                    _RETRY_HINTS.pop(next(iter(_RETRY_HINTS)))
        _progress_event({"event": "MODEL_COMPLETION", "requestNumber": self.number,
                         "mode": self.mode, "outcome": "REJECTED",
                         "exceptionType": type(exc).__name__,
                         "failureReason": str(exc) if isinstance(exc, MiMoProtocolError)
                                          else "transport or response exception"})

    def report(self, final=False):
        # Actual partial wire bytes, not a reconstructed paraphrase. Only
        # source-authorized public DAI receives payload deltas in artifacts.
        if _trace_enabled() and self.last_published < len(self.wire):
            import base64
            end = len(self.wire)
            # Keep private log lines manageable; the parent stores all deltas.
            for offset in range(self.last_published, end, 6000):
                part = bytes(self.wire[offset:min(offset + 6000, end)])
                if not _wire_event({"event": "STREAM_BYTES", "requestNumber": self.number,
                                    "direction": "MIMO_TO_AUTOPROVER", "offset": offset,
                                    "byteCount": len(part), "encoding": "base64",
                                    "payload": base64.b64encode(part).decode("ascii")}):
                    break
                self.last_published = offset + len(part)
        reasoning = sum(map(len, self.reasoning))
        answer = sum(map(len, self.content))
        tool_chars = sum(len(c["function"]["arguments"]) for c in self.calls.values())
        phase = ("complete" if final else "tool_arguments" if tool_chars else
                 "answer" if answer else "reasoning" if reasoning else "prefill")
        _progress_event({
            "event": "MODEL_STREAM_PROGRESS", "requestNumber": self.number,
            "mode": self.mode, "phase": phase,
            "promptProgress": {k: v for k, v in self.prompt.items()
                               if k in ("total", "cache", "processed", "time_ms")
                               and isinstance(v, (int, float))},
            "reasoningCharacters": reasoning, "answerCharacters": answer,
            "toolArgumentCharacters": tool_chars, "toolCalls": len(self.calls),
            "responseBytes": len(self.wire), "finishReason": self.finish_reason,
        })
        self.last_report = time.monotonic()

    def finish(self) -> dict:
        self.report(final=True)
        self._reject_repetition()
        if self.pending.strip() or not self.done or self.finish_reason is None:
            raise MiMoProtocolError("Incomplete MiMo SSE completion")
        if self.meta.get("model") != MODEL_ID:
            raise MiMoProtocolError("MiMo stream did not identify the qualified model")
        msg = {"role": "assistant", "content": "".join(self.content)}
        if self.reasoning:
            msg["reasoning_content"] = "".join(self.reasoning)
        if self.calls:
            if sorted(self.calls) != list(range(len(self.calls))):
                raise MiMoProtocolError("MiMo stream tool indices are discontinuous")
            msg["tool_calls"] = [self.calls[i] for i in sorted(self.calls)]
        body = {**self.meta, "object": "chat.completion",
                "choices": [{"index": 0, "finish_reason": self.finish_reason,
                             "message": msg}], "usage": self.usage,
                "timings": self.timings}
        # Record the actual completed wire stream even if the result is rejected.
        _wire_event({"event": "STREAM_COMPLETE", "requestNumber": self.number,
                     "direction": "MIMO_TO_AUTOPROVER", "byteCount": len(self.wire),
                     "sha256": hashlib.sha256(self.wire).hexdigest()})
        self.wire_complete = True
        validate_mimo_chat_completion(body, self.request)
        if self.mode == "component_analysis_schema":
            # The server generated the native schema object as JSON text.
            # Do not synthesize facts or execute the result tool here. Preserve
            # the exact model-produced arguments; the native result tool's
            # Pydantic schema and connectivity validator decide acceptance.
            if self.calls or self.finish_reason != "stop":
                raise MiMoProtocolError("Component analysis did not return a completed schema object")
            arguments = msg["content"]
            if not isinstance(json.loads(arguments), dict):
                raise MiMoProtocolError("Component analysis result is not a JSON object")
            schema = self.request["response_format"]["json_schema"]["schema"]
            call_id = "call_" + hashlib.sha256(
                (str(self.meta.get("id")) + ":" + str(self.number)).encode("utf-8")
            ).hexdigest()[:24]
            msg = {"role": "assistant", "content": None,
                   "tool_calls": [{"type": "function", "id": call_id,
                                   "function": {"name": "result", "arguments": arguments}}]}
            body["choices"][0]["message"] = msg
            body["choices"][0]["finish_reason"] = "tool_calls"
            # Validate the actual adapter-to-AutoProver envelope against the
            # same original native result schema and the only offered tool.
            validate_mimo_chat_completion(body, {
                "model": MODEL_ID, "tool_choice": "required",
                "tools": [{"type": "function", "function": {
                    "name": "result", "parameters": schema}}],
            })
            _progress_event({"event": "NATIVE_RESULT_ENVELOPE_PACKAGED",
                             "requestNumber": self.number,
                             "mode": self.mode, "argumentBytes": len(arguments.encode("utf-8")),
                             "argumentSha256": hashlib.sha256(arguments.encode("utf-8")).hexdigest(),
                             "nativeValidationPending": True})
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        _wire_body("ADAPTER_TO_AUTOPROVER", self.number, raw, status=200)
        _progress_event({"event": "MODEL_COMPLETION", "requestNumber": self.number,
                         "mode": self.mode, "outcome": "ENVELOPE_ACCEPTED",
                         "finishReason": self.finish_reason,
                         "promptTokens": self.usage.get("prompt_tokens"),
                         "completionTokens": self.usage.get("completion_tokens"),
                         "cachedTokens": self.usage.get("prompt_tokens_details", {}).get("cached_tokens"),
                         "toolCalls": len(msg.get("tool_calls") or []),
                         "adapterFinishReason": body["choices"][0]["finish_reason"]})
        return body


def _native_stream_request(request: httpx.Request):
    payload = json.loads(request.read())
    request_key = hashlib.sha256(json.dumps(payload, sort_keys=True,
                                           separators=(",", ":")).encode("utf-8")).hexdigest()
    payload, mode = _prepare_native_payload(payload)
    with _TRACE_LOCK:
        hint = _RETRY_HINTS.pop(request_key, None)
    if hint:
        messages = [dict(m) for m in payload.get("messages") or []]
        if messages and messages[0].get("role") == "system" and isinstance(messages[0].get("content"), str):
            messages[0]["content"] += "\n\nRetry feedback: " + hint
        else:
            messages.insert(0, {"role": "system", "content": "Retry feedback: " + hint})
        payload["messages"] = messages
    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}
    payload["return_progress"] = True
    payload["sse_ping_interval"] = 15
    number = next(_PROGRESS_SEQUENCE)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = request.headers.copy()
    for key in ("content-length", "transfer-encoding"):
        headers.pop(key, None)
    headers["accept"] = "text/event-stream"
    headers["accept-encoding"] = "identity"
    actual = httpx.Request(request.method, request.url, headers=headers, content=raw,
                           extensions=dict(request.extensions))
    _wire_body("AUTOPROVER_TO_MIMO", number, raw)
    _progress_event({"event": "MODEL_REQUEST", "requestNumber": number,
                     "mode": mode, "inputBytes": len(raw),
                     "tools": len(payload.get("tools") or []),
                     "maxCompletionTokens": payload.get("max_completion_tokens",
                                                        payload.get("max_tokens")),
                     "stream": True})
    return actual, _NativeStream(number, mode, payload, request_key)


def _native_stream_response(status: int, body: dict) -> httpx.Response:
    return httpx.Response(status, json=body)


class _NativeSyncTransport(httpx.BaseTransport):
    def __init__(self):
        self.inner = httpx.HTTPTransport(trust_env=False)

    def handle_request(self, request):
        if request.url.path != "/v1/chat/completions":
            raise MiMoProtocolError("Unexpected native MiMo API path")
        actual, stream = _native_stream_request(request)
        try:
            response = self.inner.handle_request(actual)
        except httpx.TransportError as exc:
            stream.failed(exc)
            raise
        response.request = actual
        try:
            if response.status_code >= 400:
                raw = response.read()
                _wire_body("MIMO_TO_AUTOPROVER", stream.number, raw, response.status_code)
                return httpx.Response(response.status_code, headers=response.headers, content=raw)
            if "text/event-stream" not in response.headers.get("content-type", ""):
                raise MiMoProtocolError("MiMo did not honor streaming request")
            try:
                for chunk in response.iter_bytes():
                    stream.feed(chunk)
                return _native_stream_response(response.status_code, stream.finish())
            except Exception as exc:
                stream.failed(exc)
                raise
        finally:
            response.close()

    def close(self):
        self.inner.close()


class _NativeAsyncTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.inner = httpx.AsyncHTTPTransport(trust_env=False)

    async def handle_async_request(self, request):
        await request.aread()
        actual, stream = _native_stream_request(request)
        try:
            response = await self.inner.handle_async_request(actual)
        except httpx.TransportError as exc:
            stream.failed(exc)
            raise
        response.request = actual
        try:
            if response.status_code >= 400:
                raw = await response.aread()
                _wire_body("MIMO_TO_AUTOPROVER", stream.number, raw, response.status_code)
                return httpx.Response(response.status_code, headers=response.headers, content=raw)
            if "text/event-stream" not in response.headers.get("content-type", ""):
                raise MiMoProtocolError("MiMo did not honor streaming request")
            try:
                async for chunk in response.aiter_bytes():
                    stream.feed(chunk)
                return _native_stream_response(response.status_code, stream.finish())
            except Exception as exc:
                stream.failed(exc)
                raise
        finally:
            await response.aclose()

    async def aclose(self):
        await self.inner.aclose()


def _observe_native_component_analysis():
    if not os.environ.get("CURVEYIELD_FORMAL_PROJECT_ROOT"):
        return
    import composer.spec.system_analysis as analysis
    original = analysis.run_component_analysis
    if getattr(original, "_curveyield_observed", False):
        return

    @wraps(original)
    async def observed(*args, **kwargs):
        _progress_event({"event": "NATIVE_COMPONENT_ANALYSIS_STARTED"})
        result = await original(*args, **kwargs)
        _progress_event({"event": "NATIVE_COMPONENT_ANALYSIS_ACCEPTED" if result is not None
                         else "NATIVE_COMPONENT_ANALYSIS_NO_RESULT",
                         "components": len(result.components) if result is not None else 0})
        return result

    observed._curveyield_observed = True
    analysis.run_component_analysis = observed


def _trusted_http_client() -> httpx.Client:
    if os.environ.get("CURVEYIELD_FORMAL_PROJECT_ROOT"):
        return httpx.Client(trust_env=False, transport=_NativeSyncTransport())
    return httpx.Client(
        trust_env=False,
        event_hooks={"request": [_log_request], "response": [_sync_local_response]},
    )


def _trusted_async_http_client() -> httpx.AsyncClient:
    if os.environ.get("CURVEYIELD_FORMAL_PROJECT_ROOT"):
        return httpx.AsyncClient(trust_env=False, transport=_NativeAsyncTransport())
    return httpx.AsyncClient(
        trust_env=False,
        event_hooks={"request": [_log_request_async], "response": [_async_local_response]},
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
        try:
            parsed = output_type.model_validate_json(response.choices[0].message.content)
        except Exception as exc:
            _wire_event({"event": "AUTOSETUP_SCHEMA_VALIDATION",
                         "outcome": "REJECTED", "schema": output_type.__name__,
                         "exceptionType": type(exc).__name__})
            raise
        _wire_event({"event": "AUTOSETUP_SCHEMA_VALIDATION",
                     "outcome": "ACCEPTED", "schema": output_type.__name__})
        return parsed

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
        try:
            parsed = output_type.model_validate_json(response.choices[0].message.content)
        except Exception as exc:
            _wire_event({"event": "AUTOSETUP_SCHEMA_VALIDATION",
                         "outcome": "REJECTED", "schema": output_type.__name__,
                         "exceptionType": type(exc).__name__})
            raise
        _wire_event({"event": "AUTOSETUP_SCHEMA_VALIDATION",
                     "outcome": "ACCEPTED", "schema": output_type.__name__})
        return parsed

    llm._init_local_client = _local_sync
    llm._init_async_local_client = _local_async
    llm._local_call_structured = _strict_sync
    llm._local_call_structured_async = _strict_async
    llm._curveyield_mimo_strict = True
    _observe_native_component_analysis()
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
            timeout=3600.0,
            max_retries=2,
            streaming=False,
            disable_streaming=True,  # native SDK receives fully validated JSON; transport streams MiMo.
            extra_body=({"chat_template_kwargs": {"enable_thinking": False},
                         "reasoning_effort": "none"} if disable_thinking and
                        os.environ.get("CURVEYIELD_FORMAL_PROJECT_ROOT") else None),
            # Ignore ambient HTTP(S)_PROXY and other inherited proxy settings.
            http_client=_trusted_http_client(),
            http_async_client=_trusted_async_http_client(),
            callbacks=standard_callbacks(self.price_provider),
        )


MIMO_SPEC = ProviderSpec(
    matches=lambda name: name == MODEL_ID,
    build=MiMoModelProvider.create,
)
