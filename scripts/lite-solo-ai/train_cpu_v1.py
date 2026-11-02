#!/usr/bin/env python3
"""Eight-rank, text-only, source-bound MiMo 9B LoRA CPU pipeline trainer.

This is a training execution engine, not an audit controller and not a test.
Eight ranks each own exactly four Qwen3.5 decoder layers. No rank instantiates
the full model. Private campaign material must not be used as a training input.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time

def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as src:
        for part in iter(lambda: src.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()

def args():
    p = argparse.ArgumentParser()
    p.add_argument("--dataset", required=True)
    p.add_argument("--model-revision", required=True)
    p.add_argument("--rank", type=int, required=True)
    p.add_argument("--world-size", type=int, default=8)
    p.add_argument("--master-addr", required=True)
    p.add_argument("--master-port", type=int, default=29631)
    p.add_argument("--steps", type=int, default=1)
    p.add_argument("--sequence-length", type=int, default=128)
    p.add_argument("--minutes", type=int, default=65)
    p.add_argument("--resume", default="")
    p.add_argument("--output", required=True)
    a = p.parse_args()
    if a.world_size != 8 or a.rank not in range(8):
        p.error("MiMo 9B training requires eight distinct pipeline ranks")
    if not re.fullmatch(r"[0-9a-f]{40}", a.model_revision):
        p.error("Pin a full, immutable Hugging Face commit")
    if not (1 <= a.steps <= 100 and 32 <= a.sequence_length <= 256 and 1 <= a.minutes <= 70):
        p.error("Unsafe training resource budget")
    if a.dataset.startswith("/") or ".." in Path(a.dataset).parts:
        p.error("Training data must be a checked-in relative JSONL path")
    data = Path(a.dataset).resolve()
    root = Path(os.getcwd()).resolve()
    if not data.is_file() or not data.is_relative_to(root):
        p.error("Checked-in public JSONL dataset not found")
    if data.stat().st_size > 2 * 1024 * 1024:
        p.error("Dataset exceeds 2 MiB bounded public training input")
    if not (a.master_addr.startswith("100.") or ":" in a.master_addr):
        p.error("The rendezvous address must be the Tailscale private address")
    a.dataset = str(data)
    return a

def main():
    a = args()
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    import torch.distributed as dist
    from huggingface_hub import HfApi, hf_hub_download
    from safetensors import safe_open
    from transformers import AutoTokenizer, Qwen3_5TextConfig
    from transformers.models.qwen3_5.modeling_qwen3_5 import (
        Qwen3_5DecoderLayer, Qwen3_5RotaryEmbedding, Qwen3_5RMSNorm
    )

    torch.set_num_threads(4)
    model_id = "XiaomiMiMo/MiMo-V2.6-Distill-Qwen-9B"
    sha = HfApi().model_info(model_id, revision=a.model_revision).sha
    if sha != a.model_revision:
        raise RuntimeError("MiMo source revision identity mismatch")
    root = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "mimo-training"
    root.mkdir(parents=True, exist_ok=True)
    cfg_file = hf_hub_download(model_id, "config.json", revision=sha, local_dir=root)
    index_file = hf_hub_download(model_id, "model.safetensors.index.json", revision=sha, local_dir=root)
    config_data = json.loads(Path(cfg_file).read_text())
    c = Qwen3_5TextConfig(**config_data["text_config"])
    if c.num_hidden_layers != 32 or c.hidden_size != 4096:
        raise RuntimeError("Unexpected model architecture: do not guess partition sizes")
    if sum(t == "full_attention" for t in c.layer_types) != 8:
        raise RuntimeError("Unsupported Qwen3.5 hybrid layer topology")
    # Four decoder layers per worker, contiguous with the source layer numbering.
    first, last = a.rank * 4, a.rank * 4 + 4

    class LoRALinear(nn.Module):
        def __init__(self, base, r=8, alpha=16):
            super().__init__()
            self.base = base
            self.base.requires_grad_(False)
            self.a = nn.Parameter(torch.empty(r, base.in_features, dtype=torch.float32))
            self.b = nn.Parameter(torch.zeros(base.out_features, r, dtype=torch.float32))
            nn.init.kaiming_uniform_(self.a, a=5 ** 0.5)
            self.scaling = alpha / r

        def forward(self, x):
            return self.base(x) + (F.linear(F.linear(x, self.a), self.b) * self.scaling)

    class Stage(nn.Module):
        def __init__(self):
            super().__init__()
            self.embed_tokens = nn.Embedding(c.vocab_size, c.hidden_size) if a.rank == 0 else None
            self.layers = nn.ModuleDict({str(i): Qwen3_5DecoderLayer(c, i) for i in range(first, last)})
            self.rotary = Qwen3_5RotaryEmbedding(c)
            self.norm = Qwen3_5RMSNorm(c.hidden_size, eps=c.rms_norm_eps) if a.rank == 7 else None
            self.lm_head = nn.Linear(c.hidden_size, c.vocab_size, bias=False) if a.rank == 7 else None

        def forward(self, x):
            if self.embed_tokens is not None:
                x = self.embed_tokens(x)
            seq = x.shape[1]
            pos = torch.arange(seq, dtype=torch.long).unsqueeze(0)
            # Qwen3.5's multimodal positional representation is 3 x batch x seq.
            pos3 = pos.unsqueeze(0).expand(3, -1, -1)
            rope = self.rotary(x, pos3)
            causal = torch.full((seq, seq), torch.finfo(x.dtype).min, dtype=x.dtype).triu_(diagonal=1)
            causal = causal.unsqueeze(0).unsqueeze(0)
            for layer in self.layers.values():
                mask = causal if layer.block_type == "full_attention" else None
                x = layer(x, position_embeddings=rope, attention_mask=mask, position_ids=pos3, use_cache=False)
            if self.norm is not None:
                x = self.norm(x)
                x = self.lm_head(x)
            return x

    # Instantiate only owned modules; assign exact matching safe-tensor keys.
    stage = Stage().to(dtype=torch.float32)
    stage.requires_grad_(False)
    index = json.loads(Path(index_file).read_text())["weight_map"]
    params = dict(stage.named_parameters())
    weights = {}
    for original, filename in index.items():
        match = re.search(r"\.layers\.(\d+)\.(.+)$", original)
        if match:
            layer = int(match.group(1))
            if first <= layer < last:
                weights[original] = (filename, f"layers.{layer}.{match.group(2)}")
        elif a.rank == 0 and original.endswith("embed_tokens.weight"):
            weights[original] = (filename, "embed_tokens.weight")
        elif a.rank == 7 and original.endswith("norm.weight") and ".layers." not in original:
            weights[original] = (filename, "norm.weight")
        elif a.rank == 7 and original == "lm_head.weight":
            weights[original] = (filename, "lm_head.weight")
    required = set(params)
    assigned = {local for _, local in weights.values()}
    if required != assigned:
        raise RuntimeError(f"Model stage {a.rank} missing or ambiguous tensors: missing={sorted(required-assigned)[:12]}, extra={sorted(assigned-required)[:12]}")
    for filename in sorted({name for name, _ in weights.values()}):
        local_file = hf_hub_download(model_id, filename, revision=sha, local_dir=root)
        with safe_open(local_file, framework="pt", device="cpu") as sf:
            with torch.no_grad():
                for remote, (shard, local) in weights.items():
                    if shard == filename:
                        src = sf.get_tensor(remote)
                        dest = params[local]
                        if src.shape != dest.shape:
                            raise RuntimeError(f"Shape mismatch for {remote}")
                        dest.copy_(src.to(dtype=dest.dtype))
        # Remove fetched shard to respect the 14 GB runner disk budget.
        Path(local_file).unlink()
    stage.requires_grad_(False)

    # LoRA applies to audited text-decoder projection modules, not the vocabulary or vision head.
    suffixes = ("q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj", "out_proj",
                "in_proj_qkv", "in_proj_z", "in_proj_b", "in_proj_a")
    for layer in stage.layers.values():
        for module in list(layer.modules()):
            for name, child in list(module.named_children()):
                if isinstance(child, nn.Linear) and name in suffixes:
                    setattr(module, name, LoRALinear(child))
    trainables = {name: p for name, p in stage.named_parameters() if p.requires_grad}
    if not trainables:
        raise RuntimeError("No trainable adapter parameters in pipeline stage")
    opt = torch.optim.AdamW(trainables.values(), lr=1e-4)

    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=sha, use_fast=True)
    records = []
    for line in Path(a.dataset).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        prompt, response = item.get("prompt"), item.get("completion")
        if not isinstance(prompt, str) or not isinstance(response, str) or not prompt.strip() or not response.strip():
            raise RuntimeError("Every training record requires nonempty prompt/completion strings")
        if len(prompt) + len(response) > 12000:
            raise RuntimeError("Training record exceeds bounded public context")
        records.append((prompt, response))
    if not records:
        raise RuntimeError("No verified public training records provided")
    dataset_hash = digest(a.dataset)
    dist.init_process_group(
        backend="gloo",
        init_method=f"tcp://{a.master_addr}:{a.master_port}",
        rank=a.rank,
        world_size=a.world_size,
        timeout=__import__("datetime").timedelta(minutes=15),
    )
    # All ranks must have EXACT dataset and source identities before continuing.
    identity = f"{sha}:{dataset_hash}:{len(records)}:{a.sequence_length}"
    identities = [None] * a.world_size
    dist.all_gather_object(identities, identity)
    if any(i != identity for i in identities):
        raise RuntimeError("Distributed model/dataset identity mismatch")
    start_step = 0
    if a.resume:
        state = torch.load(a.resume, map_location="cpu", weights_only=True)
        if state.get("identity") != identity or state.get("rank") != a.rank:
            raise RuntimeError("Checkpoint identity or rank mismatch")
        stage.load_state_dict(state["adapter"], strict=False)
        opt.load_state_dict(state["optimizer"])
        start_step = int(state["step"])
    steps_seen = [None] * a.world_size
    dist.all_gather_object(steps_seen, start_step)
    if len(set(steps_seen)) != 1:
        raise RuntimeError("Distributed checkpoint steps disagree")
    if start_step >= a.steps:
        raise RuntimeError("Checkpoint already meets requested training target")

    def encode_record(idx):
        prompt, completion = records[idx % len(records)]
        prefix = f"<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
        prefix_ids = tokenizer.encode(prefix, add_special_tokens=False)
        completion_ids = tokenizer.encode(completion + "<|im_end|>", add_special_tokens=False)
        joined = prefix_ids + completion_ids
        if len(joined) < 3 or len(joined) > a.sequence_length + 1:
            raise RuntimeError("Dataset example exceeds sequence length; choose a shorter verified example")
        inp = torch.tensor(joined[:-1], dtype=torch.long).unsqueeze(0)
        labels = torch.tensor(joined[1:], dtype=torch.long)
        labels[:max(0, len(prefix_ids)-1)] = -100
        if not torch.any(labels != -100):
            raise RuntimeError("Completion target was truncated")
        return inp, labels

    out = Path(a.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + a.minutes * 60
    stage.train()
    # Conservative synchronous backward protocol: at every step, gradients flow
    # from rank 7 to rank 0 through every owned layer. No fake memory pooling.
    for step in range(start_step, a.steps):
        inp, labels = encode_record(step)
        n = inp.shape[1]
        opt.zero_grad(set_to_none=True)
        if a.rank == 0:
            result = stage(inp)
        else:
            incoming = torch.empty(1, n, c.hidden_size, dtype=torch.float32)
            dist.recv(incoming, src=a.rank - 1)
            incoming.requires_grad_()
            result = stage(incoming)
        if a.rank < 7:
            dist.send(result.detach().contiguous(), dst=a.rank + 1)
            gradient = torch.empty_like(result)
            dist.recv(gradient, src=a.rank + 1)
            result.backward(gradient)
        else:
            loss = F.cross_entropy(result.reshape(-1, c.vocab_size), labels.reshape(-1), ignore_index=-100)
            if not torch.isfinite(loss):
                raise RuntimeError("Nonfinite model training loss")
            loss.backward()
        if a.rank > 0:
            dist.send(incoming.grad.contiguous(), dst=a.rank - 1)
        opt.step()
        # All ranks commit checkpoint generation after the optimizer step.
        dist.barrier()
        training = {
            "identity": identity, "rank": a.rank, "step": step + 1,
            "adapter": {k: v.cpu() for k, v in stage.state_dict().items() if ".a" in k or ".b" in k},
            "optimizer": opt.state_dict(),
        }
        tmp = out.with_suffix(".tmp")
        torch.save(training, tmp)
        os.replace(tmp, out)
        dist.barrier()
        if time.monotonic() >= deadline:
            break
    print(json.dumps({"rank": a.rank, "checkpoint": str(out), "step": step + 1,
                      "model_sha": sha, "dataset_sha256": dataset_hash,
                      "status": "CHECKPOINT_WRITTEN_NOT_VALIDATED"}), flush=True)
    dist.destroy_process_group()

if __name__ == "__main__":
    main()
