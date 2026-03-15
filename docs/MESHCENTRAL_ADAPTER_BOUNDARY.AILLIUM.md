# MESHCENTRAL_ADAPTER_BOUNDARY.AILLIUM.md

Adapter contract for `aillium-remote-meshcentral` as a dedicated MeshCentral remote-support substrate.

## 1) Purpose

This repository exposes a **remote-support adapter boundary** for Aillium Core.

It is intentionally constrained to MeshCentral substrate concerns:
- device targeting
- support session creation
- control handoff metadata
- session/evidence metadata linkage
- tenant/device group mapping

It must **not** become a general task runtime or policy engine.

## 2) Upstream/Downstream Boundary

- Upstream caller: `aillium-core` via MeshCentral remote-support contract family in `aillium-schemas`.
- Downstream substrate: MeshCentral APIs, data model, and operator/agent pathways.
- Explicit non-callers for runtime work: `aillium-openclaw` runtime contracts are out of scope in this repo.

## 3) Adapter Operations (Contract Surface)

The adapter service layer in this repo is expected to expose these operations:

1. `resolveDeviceTarget(request)`
   - Input intent: tenant scope + target selector.
   - Output intent: resolved MeshCentral node/group identifiers + targeting evidence.

2. `createSupportSession(request)`
   - Input intent: target + operator identity + requested capability set.
   - Output intent: support session reference, launch/handoff details, and session state.

3. `handoffSessionControl(request)`
   - Input intent: support session reference + next controller (human/system).
   - Output intent: handoff status, effective controller, and audit metadata.

4. `captureSessionEvidence(request)`
   - Input intent: support session reference + event metadata.
   - Output intent: normalized evidence envelope and storage pointer metadata.

5. `mapDeviceToTenantGroup(request)`
   - Input intent: tenant context + device identity.
   - Output intent: MeshCentral group mapping status and resulting identifiers.

## 4) Payload/Naming Alignment Rules

The adapter implementation must align field naming and envelope shape with the **MeshCentral remote-support** schema family in `aillium-schemas`.

Alignment rules:
- Use remote-support terms (`deviceTarget`, `supportSession`, `controlHandoff`, `evidence`, `tenantGroupMapping`).
- Do not use OpenClaw runtime terms in this adapter contract (`runtimeTask`, `toolExecution`, `workerDispatch`).
- Keep deprecated worker compatibility mappings isolated and explicitly marked as transitional.

## 5) Deferred Integration Areas (Live MeshCentral API)

The following are intentionally deferred placeholders until live MeshCentral API wiring is implemented:
- Device lookup/query against live MeshCentral inventory APIs.
- Session launch/link creation against live relay/session APIs.
- Control transfer calls tied to live operator/session state.
- Evidence persistence integrations (log pipeline, object storage references).
- Group provisioning/mapping synchronization with live MeshCentral groups.

All deferred paths must fail clearly with explicit "not yet integrated" errors instead of silently simulating success.

## 6) Explicitly Out of Scope

Out of scope for this adapter/service layer:
- OpenClaw runtime task execution.
- Generic command/script executor interfaces.
- Policy/approval/entitlement decisioning.
- Billing authority/event ownership.

## 7) Existing Repo Signals Informing This Boundary

Current upstream MeshCentral code already contains substrate primitives this adapter will eventually call:
- Agent packaging/install script and download surfacing (`/meshagents` routes and binary/script inventories).
- Relay/session transport infrastructure.
- Domain/user rights controls and account constraints.

This adapter layer exists to normalize those primitives into the Aillium Core remote-support contract surface without importing runtime-executor responsibilities.
