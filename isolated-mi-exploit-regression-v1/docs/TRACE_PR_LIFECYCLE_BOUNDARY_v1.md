# Trace request pull request lifecycle boundary v1

## Review performed

The live main branch has two existing lifecycle paths:

- `packages/github-bridge` accepts an authorized issue, submits the validated job, polls to a terminal `completed` or `failed` result, posts the summary and result evidence, then closes the issue.
- `.github/workflows/v7-agent-qualification-bridge.yml` dispatches a canonical qualification run from a dedicated trigger issue, records the run marker, and closes that trigger issue.

The GitHub bridge explicitly rejects pull requests. The V7 execution workflow validates and executes request payloads, verifies terminal execution evidence for controller operations, and writes deterministic controller results back with compare-and-swap protection. It does not receive a canonical trace pull request lifecycle record that binds a pull request number to the request digest, campaign generation, terminal evidence, reconciliation result, and retry state.

## Decision

Terminal trace pull requests remain manual until the controller publishes that lifecycle record.

The repository contains heterogeneous historical trace and diagnostic pull requests. Their bodies use human text such as `Trace-only`, `Do not merge`, or `DO NOT MERGE`, while their workflows and evidence locations differ. Those phrases and green workflow checks do not prove:

- the canonical execution is terminal;
- all required evidence is durable and addressable;
- private writeback or reconciliation completed;
- the request is not waiting for retry or runner rebind;
- the request identity matches the pull request and campaign generation.

Automatically closing from those signals could close an active, ambiguous, retryable, or otherwise incomplete audit request.

## Required future contract

A safe implementation needs a machine-readable lifecycle record containing at least:

- repository and pull request number;
- exact request digest and source commit;
- campaign ID and generation;
- terminal execution status and run/job/artifact identities;
- durable evidence digests;
- private writeback/reconciliation status;
- retry/rebind obligation status;
- explicit `traceOnly: true` and `doNotMerge: true` flags.

A close operation must re-read that record and the current pull request head, fail closed on any mismatch, and preserve the immutable evidence links in a final comment before closing.

Until that contract exists, manual closure is the intentional safe boundary. This avoids creating a cleanup workflow that could mistake a historical trace marker for proof of terminal audit completion.
