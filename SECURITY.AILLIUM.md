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

## 7) Governed Desktop Effect Gateway

Automated desktop effects must use `aillium/fencedGateway.server.js`; direct access to
Mesh effect routes is not a supported Aillium execution path. The gateway:

- verifies the Ed25519 desktop-control capability issued by Aillium Core;
- requires the token, headers, and request body to carry the same execution identity;
- reserves the operation ID and canonical effect digest before an effect can run;
- applies attempt, fence-token, and cancellation-generation monotonicity at reservation,
  execution, and completion;
- persists the result and correlated proof for idempotent replay; and
- exposes only the explicitly allowlisted primitive Mesh effect routes.

`FileFenceStore` enforces one process owner with a kernel-held exclusive loopback TCP lease
(`AILLIUM_MESH_FENCE_STORE_LOCK_PORT`) acquired before any audit-file recovery. The kernel
releases the lease on process crash; PID/nonce lock files are audit metadata, not ownership
authority. Its durable commit is file fsync, atomic rename, then directory fsync. An effect
left `executing` by a crash is recovered as `unknown`, never replayed automatically.
The gateway serializes each lineage through its actual upstream promise; a newer fence or
`POST /_aillium/fence/cancel` aborts the older upstream signal and waits for it to settle
before advancing authority. A disconnected desktop client also aborts that signal.

Multi-replica, multi-host, or separate-network-namespace deployments must replace
`FileFenceStore`, its host-local lease, and the in-process lineage coordinator with a
transactional shared implementation before scaling the gateway (PSD-012). The gateway port
must remain private to the Aillium application network. User-controlled manual MeshCentral
support sessions are a separate handoff surface and are not represented as governed
automated effects.
