# ADR-0005: Durable jobs, inbox and outbox in PostgreSQL

- Status: accepted
- Date: 2026-10-19

## Decision

- A `job` table holds: type, company_id, payload (jsonb), status (`queued`, `running`, `succeeded`, `failed`, `held`, `uncertain`, `cancelled`), attempts, max_attempts, run_after, locked_by, locked_until, timeout, last_error, correlation_id and idempotency_key (unique).
- Workers claim jobs with `SELECT … FOR UPDATE SKIP LOCKED` in short transactions, run each with a timeout, and back off exponentially between bounded retries. If a worker dies, its lease expires and the job becomes claimable again. A job is only retried if its handler declares it safe to retry.
- Business intent (a print job, a send request) is written in the same transaction as the `job` row. That is the outbox pattern.
- Inbound provider events go to `integration_inbox` with a unique `(connection_id, external_event_id)`. Duplicates are recorded as such and not reprocessed.
- At-least-once delivery is assumed. Handlers must be idempotent, and external side effects use provider idempotency keys where available. If a timeout leaves the outcome unknown, the job becomes `uncertain`, an audit and notification is raised, and nothing is resubmitted blindly.
- Before executing, each handler re-checks the automation switches. A disabled switch moves the job to `held`, which needs an explicit, audited release.
- Redis is not used until a measured requirement exists.

## Consequences

- No extra infrastructure. Queue throughput is easily enough for a small team.
- Long-running media jobs (later) need their own concurrency limits per job type.
