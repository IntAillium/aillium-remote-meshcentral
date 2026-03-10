# ARCH_BOUNDARIES.AILLIUM.md

Architecture boundaries for `aillium-remote-meshcentral`.

## 1) System Role

`aillium-remote-meshcentral` is the **Data Plane remote access substrate** for the Tech Support MVP.

It provides connectivity/session capability and does not own planning, policy, business logic, or billing.

## 2) Executor-Only Boundary

- Intended consumer: `aillium-tars`.
- Not for direct integration by `aillium-core` or `aillium-openclaw`.

Rationale:
- Keep control-plane policy/approval concerns upstream.
- Keep the remote substrate narrowly scoped to session transport.

## 3) Passive Behavior Requirement

MeshCentral in this repo must remain passive:
- No autonomous behavior.
- No policy approval/rejection logic.
- No decisioning on entitlement, billing, or governance.

## 4) Human + Headless MVP Model

Allowed in v1:
- Headless/agent-first usage through executor pathways.
- Human technician UI usage for support operations.

Both paths require explicit consent handling and auditability managed by operational process and upstream systems.

## 5) Stateless Preference and Source of Truth

- Prefer stateless service posture where possible.
- Operational state required by MeshCentral may exist locally (runtime/session metadata), but tenant ownership authority remains external.
- `aillium-core` remains source of truth for tenant↔device ownership mappings.

## 6) Explicit Deferrals

Out of scope for this v1 minimum:
- SIEM/Wazuh integrations.
- Billing/OpenMeter usage events.
- MeshCentral scripting/playbook execution.
