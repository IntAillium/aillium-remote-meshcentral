# MESHCENTRAL_ALIGNMENT_REPORT.AILLIUM.md

Alignment report for formalizing MeshCentral as a dedicated remote-support substrate.

## 1) Repo Inspection Findings

### Agent packaging logic
- MeshCentral exposes agent/tool package references and install scripts via `/meshagents` URL pathways and architecture maps.
- Relevant substrate areas include tool binary listing, install script inventory, and agent binary metadata handling.
- Current repo suitability: **good substrate fit** (this is part of remote-support onboarding/distribution concerns).

### Connectivity/session substrate logic
- Relay/session transport infrastructure exists in upstream MeshCentral server pathways (relay servers and session accounting).
- Current repo suitability: **good substrate fit** (session transport/control is core purpose).

### RBAC defaults and account rights
- Domain-level rights and account defaults are represented by MeshCentral domain configuration handling.
- Current repo suitability: **good substrate fit** when constrained to support access posture and tenancy scoping.

### Drift toward generic execution/runtime behavior
- Upstream MeshCentral supports broad automation-capable surfaces (for example task manager and script/playbook-related capabilities) that can drift into generic execution patterns if left unconstrained.
- Required posture in this repo: **documented non-goal** and explicit exclusion from adapter contract/service layer.

### Placeholders for live MeshCentral integration
- Deployment templates remain placeholders for environment/runtime wiring (`.env.example`, compose scaffold).
- Aillium-specific adapter operations are now represented as explicit deferred integration points awaiting live API wiring.

## 2) Adapter Boundary Definition (Expected by Aillium Core)

The dedicated adapter boundary now uses explicit operations for:
- `resolveDeviceTarget`
- `createSupportSession`
- `handoffSessionControl`
- `captureSessionEvidence`
- `mapDeviceToTenantGroup`

These operations are intentionally remote-support scoped and exclude OpenClaw runtime task responsibilities.

## 3) `aillium-schemas` Naming/Payload Alignment

Boundary naming is aligned to MeshCentral remote-support contract family terms:
- `deviceTarget`
- `supportSession`
- `controlHandoff`
- `evidence`
- `tenantGroupMapping`

Explicit anti-drift rule:
- Do not encode OpenClaw runtime payload concepts (`runtimeTask`, `toolExecution`, `workerDispatch`) in this adapter layer.

## 4) Adapter Contract/Service Home Added

Dedicated local home for future live integration:
- `aillium/meshcentralRemoteSupportAdapter.contract.json`
- `aillium/meshcentralRemoteSupportAdapter.service.js`

This provides a stable location for replacing deferred envelopes with live MeshCentral API calls without expanding scope into runtime execution.

## 5) Deferred/Placeholder Areas (Clearly Marked)

Deferred until live integration:
- Device query/lookup wiring.
- Session launch/control transfer wiring.
- Evidence persistence/storage-pointer wiring.
- Tenant-group provisioning synchronization.

All deferred operations return an explicit deferred envelope and may throw `DeferredIntegrationError` when strict live integration is required.

## 6) Scope Guardrail to Prevent OpenClaw/Core Leakage

Explicitly out of scope in this repo:
- OpenClaw runtime task execution.
- Generic executor command/script interfaces.
- Policy/approval/entitlement decisioning.
- Billing ownership.

## 7) Reusable Files

- `aillium/meshcentralRemoteSupportAdapter.contract.json`
- `aillium/meshcentralRemoteSupportAdapter.service.js`
- `docs/MESHCENTRAL_ADAPTER_BOUNDARY.AILLIUM.md`

## 8) Obsolete or Over-Scoped Files

No files removed in this patch.

Over-scoped risk areas are controlled by updated docs/guardrails rather than deletion because this repository vendors upstream MeshCentral server code.

## 9) Files Changed in This Patch

- `README.AILLIUM.md`
- `AI_GUARDRAILS.AILLIUM.md`
- `SECURITY.AILLIUM.md`
- `docs/ARCH_BOUNDARIES.AILLIUM.md`
- `docs/MESHCENTRAL_ADAPTER_BOUNDARY.AILLIUM.md`
- `docs/MESHCENTRAL_ALIGNMENT_REPORT.AILLIUM.md`
- `aillium/meshcentralRemoteSupportAdapter.contract.json`
- `aillium/meshcentralRemoteSupportAdapter.service.js`

## 10) Patch Plan Executed

1. Re-baseline architecture docs from executor-centric language to Core remote-support adapter boundary.
2. Add dedicated adapter boundary documentation with operation-level contracts.
3. Add adapter contract + service stubs for future live MeshCentral API integration.
4. Encode explicit deferred integration behavior.
5. Encode explicit non-goals preventing runtime execution scope creep.

## 11) Assumptions

- Aillium Core remains the system of record for policy/approvals and ownership mapping authority.
- `aillium-schemas` MeshCentral remote-support contract family naming is authoritative.
- Live MeshCentral API wiring is intentionally deferred to a follow-on integration patch.
