# Aillium Remote (MeshCentral)

This repository is the **remote connectivity substrate** for the Aillium platform by IntAillium.

## What this is
- A fork of MeshCentral, operated as a **remote access gateway** to managed endpoints.
- Used **only** by Aillium executors (e.g., `aillium-ui-tars`) to perform approved UI work on client devices.

## What this is NOT
- Not an executor (does not accept `executor.request`)
- Not a planner (no orchestration logic)
- Not a system of record (no task state)
- Not tenant-facing UI for customers (portal lives in `aillium-portal`)

## Integration boundary
Only the Execution Plane may connect to this service:
- ✅ `aillium-ui-tars` may connect to create remote sessions and gather evidence.
- ❌ `aillium-core` and `aillium-openclaw` must never call MeshCentral directly.

## Tenant and device scoping
- Devices must be mapped to tenants via tags/groups (documented in `docs/NETWORKING.AILLIUM.md`).
- Operators must not be able to cross-connect between tenants.

## Security posture
See:
- `SECURITY.AILLIUM.md`
- `docs/THREAT_MODEL.AILLIUM.md`
- `docs/RUNBOOK.AILLIUM.md`
