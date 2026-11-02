# Lite-Solo MiMo inference — operations v1

An isolated, manually dispatched public-source CPU inference component in Contract-Automation. It is NOT a trained or live controller-bound auditor.

To run: visit https://github.com/curveyield3/Contract-Automation/actions/workflows/lite-solo-ai-inference-v1.yml and choose Run workflow. Select a checked-in PUBLIC Solidity/Vyper file or directory. The default source budget is 12 chunks, maximum 32. Retrieve analysis.json from the Actions artifact. It is a line-anchored draft with source hashes and explicit unresolved coverage, not proof of vulnerability or controller acceptance.

The workflow runs on standard public ubuntu-latest, builds llama.cpp commit 8642541b255bfb5dc39cd351a178be09013a55d6 and downloads bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF revision 4371da10c84fb26da3592d4cf312d24aa82b7b65. The Q4_K_M model SHA256 is 4bca6f18c73f72270c7a20c2ea2bea581de8246e318714277120369d34048c81. Model weights never enter Git history.

Never pass private Audit-Controller evidence or credentials into this public run or its artifact. It has read-only repo permissions, does not claim audit units, perform tests or submit controller results. The existing Lite-Solo controller/Cloudflare fork code is unchanged.

Remaining integration: use a verified authenticated current-assignment interface, bound source/skill identity, exclusive claims, exact schemas, private output and controller acceptance/recovery, while retaining the v5 human step-boundary gate. Training requires separate GPU resources and a reviewed dataset; neither is part of this installation. Follow root and local AGENTS.md and the exact bound SKILL.md before any live audit modifications.
