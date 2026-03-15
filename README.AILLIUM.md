# aillium-remote-meshcentral

This repository is the **Data Plane remote connectivity substrate** for IntAillium.

It provides MeshCentral-based remote access capability for the Tech Support MVP and is intentionally constrained to a passive transport/session role.

## v1 Production-Ready Minimum Scope

This v1 iteration focuses on:
- Security posture and operational safety controls.
- Tenant/device scoping conventions.
- Aillium Core-to-MeshCentral remote-support adapter boundary.
- Docker Compose deployment scaffold with reverse-proxy TLS guidance.

## What this repository IS

- A remote access substrate for endpoint connectivity and remote sessions.
- A remote-support substrate consumed through **aillium-core** MeshCentral dispatch boundaries.
- A service that can support both:
  - Headless / agent-first execution patterns for automation wrappers.
  - Human technician UI access for MVP support operations.

## What this repository is NOT

- Not a policy engine.
- Not an autonomous action system.
- Not a billing/metering source.
- Not a workflow/orchestration decision-maker.
- Not the source of truth for tenant↔device ownership.

## Hard Architecture Boundary

- ✅ Allowed integration path: `aillium-core` MeshCentral remote-support contracts.
- ❌ Forbidden scope: `aillium-openclaw` runtime execution responsibilities.
- ❌ Forbidden direct role: generic task executor/runtime endpoint.
- Approvals, policy, and governance controls remain upstream responsibilities in Core.
- MeshCentral remains a passive remote-support substrate.

See: `docs/ARCH_BOUNDARIES.AILLIUM.md` and `docs/MESHCENTRAL_ADAPTER_BOUNDARY.AILLIUM.md`.

## Security and Compliance Docs

- `SECURITY.AILLIUM.md`
- `AI_GUARDRAILS.AILLIUM.md`
- `docs/RUNBOOK.AILLIUM.md`
- `docs/TENANCY_MODEL.AILLIUM.md`

## Deployment Assets

- Environment template: `.env.example` (placeholders only, no secrets)
- Compose scaffold: `docker-compose.example.yml`

## Reverse Proxy Requirement (TLS)

For production, place MeshCentral behind a reverse proxy edge (Traefik or Caddy) and terminate TLS there.

- Keep public TLS certificates and private keys at the edge.
- Restrict direct MeshCentral exposure.
- Route only required ports from edge to MeshCentral service.

Example snippets for Traefik and Caddy are provided in `SECURITY.AILLIUM.md` and operationalized in `docs/RUNBOOK.AILLIUM.md`.

## Explicit Deferrals (Out of v1)

- SIEM/Wazuh integrations.
- Billing/OpenMeter usage event pipelines.
- MeshCentral scripting/playbook execution.
