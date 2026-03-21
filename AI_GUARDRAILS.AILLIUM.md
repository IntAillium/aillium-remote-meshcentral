# AI_GUARDRAILS.AILLIUM.md

Guardrails for any AI-assisted or executor-driven integration with `aillium-remote-meshcentral`.

## Non-Negotiable Boundary

This repository is a **remote connectivity substrate only**.

Allowed role:
- Passive session/connectivity layer for remote support execution.

Disallowed roles:
- Autonomous decision-making.
- Policy/approval enforcement.
- Billing/metering decisions or event ownership.
- Device automation via MeshCentral scripting/playbooks.

## Caller and Integration Rules

- `aillium-core` is the control-plane consumer through MeshCentral remote-support contracts.
- `aillium-openclaw` runtime tasks must not be routed into this service.
- Approval and policy gates are upstream in Core and must be evaluated before remote session initiation.

## Operational Safety Rules

- Human-visible and auditable actions only.
- Prefer headless/agent-first execution patterns for controlled executor workflows.
- Human technician UI remains allowed for MVP operations under explicit consent and audit requirements.

## Prohibited Patterns

- Auto-connecting to endpoints without upstream authorization.
- Hidden/implicit policy checks implemented inside this repo.
- Emitting billing facts as authoritative records.
- Running unattended device scripts/playbooks through MeshCentral as part of this v1 scope.

## Source of Truth Constraint

Tenant↔device ownership and authoritative identity/policy context remain upstream; this repository must not become the system of record.
