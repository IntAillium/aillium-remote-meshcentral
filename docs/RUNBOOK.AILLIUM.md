# RUNBOOK.AILLIUM.md

Operational runbook for `aillium-remote-meshcentral` v1.

## 1) Deployment Topology

Production pattern:
1. Reverse proxy edge (Traefik/Caddy) receives internet traffic.
2. TLS terminates at edge.
3. Edge routes to internal MeshCentral service.
4. MeshCentral stores only required runtime/platform state.
5. Tenant/device ownership truth remains in `aillium-core`.

Use provided templates:
- `.env.example`
- `docker-compose.example.yml`

## 2) Bring-Up Procedure (Compose)

1. Copy templates:
   - `.env.example` -> environment-specific `.env` (outside git policy for secrets).
2. Fill placeholders with deployment-specific values.
3. Deploy compose stack.
4. Verify service health and edge routing.
5. Verify HTTPS endpoint and certificate validity.

## 3) Reverse Proxy Edge Placement

### Traefik placement requirements
- Route host `remote.<domain>` to internal MeshCentral service.
- Enable TLS with managed certificates.
- Avoid exposing backend service ports directly to internet.

### Caddy placement requirements
- Configure host block for remote access domain.
- Reverse proxy to internal MeshCentral port.
- Ensure HTTPS only for external access.

## 4) Tenant Onboarding (v1 Manual)

1. Confirm tenant exists upstream.
2. Create tenant-specific device group (`tenant-<tenant_id>`).
3. Generate tenant-specific installer bound to tenant group.
4. Record issuance details (who/when/tenant/package target).
5. Deliver installer through approved support process.

## 5) Session Operations and Audit

Each support session must have records linking:
- Operator identity.
- Timestamp start/end.
- Target device identity.
- Tenant context.

At minimum, verify authentication logs, session events, and admin changes are retained for review.

## 6) Revocation / Emergency Kill Switch

If unauthorized access is suspected:
1. Disable affected operator credentials.
2. Remove or disable affected device agents.
3. Isolate affected tenant group access.
4. Rotate relevant secrets/session credentials.
5. Record incident and remediation actions upstream.

## 7) Offboarding

Tenant offboarding minimum steps:
- Revoke tenant installer pathways.
- Remove tenant devices from active access groups.
- Disable tenant-scoped operator access.
- Archive required audit evidence per upstream policy.

## 8) Explicit Non-Goals in this Runbook

- SIEM/Wazuh integration procedures.
- Billing/OpenMeter event handling.
- MeshCentral scripting/playbook procedures.
