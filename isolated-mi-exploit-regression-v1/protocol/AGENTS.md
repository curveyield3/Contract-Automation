# Protocol and Schema Local Agent Rules

This file adds protocol/schema rules to the repository-root `AGENTS.md`.

- Do not create a new schema/protocol version merely to avoid editing or understanding the current one.
- Prefer compatible extension of the current canonical schema when semantics permit.
- When an incompatible version bump is genuinely required, update all active references and remove/archive the superseded active version unless backward compatibility is explicitly required.
- Do not leave multiple unreferenced schema generations in the active tree.
- Protocol files define durable interfaces; diagnostic notes, execution logs, and task status do not belong here.
