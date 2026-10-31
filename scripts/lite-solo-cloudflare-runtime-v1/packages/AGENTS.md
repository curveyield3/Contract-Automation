# Packages Local Agent Rules

This file adds package/harness rules to the repository-root `AGENTS.md`.

- Reuse the current package, harness, adapter, or runner for the responsibility before creating another.
- Do not create sibling package/harness generations for retries. Repair the current implementation.
- Only the latest live version of a same-purpose package/harness may remain in the active repository. Archive/remove superseded generations when a true version bump is required.
- Keep source in the package's source directory, tests in its test directory, requests in its established request directory, and generated results in its established results/artifact directory.
- Generated results must never be placed where they can retrigger their own workflow.
- Do not copy an entire package merely to change one configuration or test case.
- Before adding a new package directory, search for an existing module that already owns the behavior.
