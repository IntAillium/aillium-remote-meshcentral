# TENANCY_MODEL.AILLIUM.md

Tenant and device scoping model for `aillium-remote-meshcentral` (v1).

## 1) Isolation Model: Group per Tenant

Each tenant must be isolated using a dedicated MeshCentral device group.

Recommended naming convention:
- `tenant-<tenant_id>`

Guidance:
- Do not place devices from multiple tenants in the same group.
- Keep operator access scoped to only the tenant groups required for their role.

## 2) Device Lifecycle (v1)

1. Tenant is provisioned upstream.
2. Tenant group is created in MeshCentral.
3. Tenant-specific installer is generated and distributed through approved channels.
4. Device registers into tenant's designated group.
5. Decommission/removal removes device from group and disables further access as needed.

## 3) Tenant-Specific Installer Generation

v1 allows a manual process, but it must be explicit and auditable.

Minimum process:
- Generate installer using tenant-designated group context.
- Record generation event (operator, timestamp, tenant, installer target).
- Deliver installer through approved support workflow.
- Rotate/revoke installer strategy on incident or tenant offboarding.

## 4) RBAC Mapping Guidance

Suggested role intent mapping:

- **Customer role**
  - Limited visibility/control to their own tenant assets.
  - No cross-tenant access.

- **Admin role (tenant/operator admin)**
  - Administrative capabilities within assigned tenant scope.
  - No unrestricted global access by default.

- **Super-admin role (platform operations)**
  - Broad administrative capability for operational maintenance.
  - Strong controls, minimal assignment, heightened audit requirements.

## 5) Ownership Source of Truth

`aillium-core` remains authoritative for tenant↔device ownership.

MeshCentral group assignments are an execution substrate representation and must not become the canonical ownership source.
