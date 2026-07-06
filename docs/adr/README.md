# Architecture Decision Records

This directory records the significant architectural decisions made on Meridian,
including the context that forced the decision and the consequences we accepted.

Meridian is an architecture research project. The *reasoning* is the product, so
ADRs here are expected to be fuller than a typical shipping product's — they
record alternatives considered, trade-offs weighed, and assumptions we are
deliberately testing.

## Process

1. Copy `0000-template.md` to `NNNN-short-title.md` (next free number).
2. Draft it on a branch named `architecture/adr-NNNN-short-title`.
3. Status starts as `Proposed`. It becomes `Accepted` only after review.
4. Superseding decisions do not edit old records — they add a new ADR and set
   the old one's status to `Superseded by ADR-NNNN`.

## Status values

- **Proposed** — under discussion, not yet binding.
- **Accepted** — the decision we are building against.
- **Superseded by ADR-NNNN** — replaced; kept for the historical trail.
- **Deprecated** — no longer relevant, not replaced.

## Index

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](../attic/adr-0001-gateway-execution-model.md) | Gateway execution model on Lambda | Archived — project pivoted to Mayfly |

> The regional-egress ("Meridian") direction was abandoned after analysis showed it
> couldn't be both serverless and a transparent proxy. The project pivoted to **Mayfly**
> (ephemeral GitHub Actions runners on Lambda MicroVMs). The historical proxy work lives
> under [`docs/attic/`](../attic/); the current design is in
> [`docs/superpowers/specs/2026-07-07-mayfly-design.md`](../superpowers/specs/2026-07-07-mayfly-design.md).
