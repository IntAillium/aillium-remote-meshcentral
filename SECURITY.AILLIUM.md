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

## 6) Explicitly Out of Scope for v1

- SIEM/Wazuh integrations.
- Billing/OpenMeter usage metering.
- MeshCentral scripting/playbook execution.
