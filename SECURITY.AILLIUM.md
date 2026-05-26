# SECURITY.AILLIUM.md

Security posture guidance for `aillium-remote-meshcentral`.

## 1) Core Security Principles (v1)

- This service is **Data Plane only**.
- It remains **passive** and consumed through Core remote-support dispatch boundaries.
- It does not perform approvals, policy decisions, or billing logic.
- No secrets are to be stored in repository files.

## 2) Explicit User Consent and Revocation

Remote support access must be run with explicit consent and clear revocation paths.

Required operator guidance:
- Obtain explicit user/customer authorization before initiating remote session access.
- Document consent at the ticket/case layer upstream.
- Provide immediate revoke instructions to customer and operators.

Revocation / kill-switch controls (minimum):
- Disable or remove the affected device agent from MeshCentral.
- Disable technician/operator account credentials tied to session access.
- Invalidate relevant session tokens/cookies by rotating server-side secrets as needed.
- Remove device from tenant device group when emergency isolation is required.

## 3) TLS and Edge Placement

Production deployments must terminate TLS at a reverse proxy edge (Traefik or Caddy).

### Traefik example (reference snippet)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.meshcentral.rule=Host(`remote.example.com`)"
  - "traefik.http.routers.meshcentral.entrypoints=websecure"
  - "traefik.http.routers.meshcentral.tls=true"
  - "traefik.http.routers.meshcentral.tls.certresolver=letsencrypt"
  - "traefik.http.services.meshcentral.loadbalancer.server.port=4430"
```

### Caddy example (reference snippet)

```caddy
remote.example.com {
    reverse_proxy meshcentral:4430
}
```

Notes:
- Keep internet exposure at the reverse proxy boundary.
- Avoid direct public exposure of non-edge service ports.
- Enforce HTTPS-only client access.

## 4) Session Auditing Requirements (Minimum)

Capture and retain session-level audit records sufficient to answer:
- **Who** initiated/accessed a session (operator identity).
- **When** access occurred (start/end timestamps, timezone/UTC).
- **Which device** was accessed (stable device identifier and tenant context).

Minimum audit expectations:
- Authentication events (success/failure).
- Session start and end events.
- Administrative account/group changes.
- Device enrollment and removal events.

Retention and storage policy are defined by upstream governance, but v1 operations must preserve logs needed for support and incident review.

## 5) Account and Access Hygiene

- Enforce least privilege through role/group assignment.
- Use distinct admin and operator identities; avoid shared credentials.
- Disable stale operator accounts promptly.
- Rotate privileged credentials and session-related secrets on schedule and incident trigger.

### 5.1) Adapter Service Account — Required MeshCentral Rights

The adapter (`aillium/httpApi.js`) authenticates to MeshCentral with a single
service account configured via `MESHCENTRAL_USERNAME`/`MESHCENTRAL_PASSWORD`
or `MESHCENTRAL_LOGIN_KEY`. This account MUST NOT be a full site administrator
(`siteadmin = 0xFFFFFFFF`). Provision a dedicated service user scoped to the
mesh groups it needs to operate against, with only the following rights
flags enabled per operation:

| Operation | Required MeshCentral rights |
|---|---|
| `resolveDeviceTarget` | `MESHRIGHT_DEVICEDETAILS` (0x100000) on the target mesh group(s) |
| `createSupportSession` | `MESHRIGHT_REMOTECONTROL` (0x08), `MESHRIGHT_AGENTCONSOLE` (0x10) |
| `handoffSessionControl` | `MESHRIGHT_REMOTECONTROL` (0x08) |
| `captureSessionEvidence` | `MESHRIGHT_SERVERFILES` (0x40000), `SITERIGHT_RECORDINGS` (0x200) |
| `mapDeviceToTenantGroup` | `MESHRIGHT_MANAGECOMPUTERS` (0x04) on the source mesh group |

Operators can call `adapter.probeAccountPrivileges()` at startup or via a
health check to assert the configured account is not over-privileged. The
probe logs a warning if `siteadmin === 0xFFFFFFFF`.

### 5.2) Compromise Blast Radius

If the service account credentials leak, the attacker gains the rights
granted to that account — and only those. Granting full `siteadmin`
means the blast radius is the entire MeshCentral realm (every user,
every device, every recording). Scoping the service account per the
table above contains the blast radius to a single operation surface.

## 6) Explicitly Out of Scope for v1

- SIEM/Wazuh integrations.
- Billing/OpenMeter usage metering.
- MeshCentral scripting/playbook execution.
