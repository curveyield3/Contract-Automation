# Scripts Local Agent Rules

This file adds script-placement rules to the repository-root `AGENTS.md`.

- Edit/reuse the current script that owns the behavior before creating another.
- Do not create `script-v2`, `script-v3`, `script-fixed`, or `script-retry` to debug repeated failures.
- Put subsystem-specific scripts in the existing subsystem directory when one exists; do not dump unrelated scripts directly into `scripts/`.
- Keep one canonical implementation per responsibility and remove/archive superseded variants.
- Diagnostic scripts should be temporary unless they are genuinely reusable repository tooling.
- A script used by a workflow must not write generated data into a path that retriggers that workflow unless an explicit non-cyclic design proves it safe.
