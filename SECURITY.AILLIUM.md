# Security Policy — Aillium Remote (MeshCentral)

## Reporting
Report security issues privately to IntAillium:
- Email: security@intaillium.com (replace with your real address)

## Supported versions
Only the default branch of this fork is supported for production use.

## Hardening expectations
- Run behind TLS (reverse proxy preferred)
- Restrict admin access to a private network or allowlist
- Rotate secrets (cookie secret, admin bootstrap) via Vault/OpenBao
- Log access events and administrative actions

## Out of scope
- Executor behavior (belongs in `aillium-ui-tars`)
- Orchestration decisions (belongs in `aillium-openclaw`)
