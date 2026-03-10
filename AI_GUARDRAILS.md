# Aillium Guardrails — Remote Substrate (MeshCentral)

## Purpose
This repository provides remote connectivity only. It must remain a substrate, not a worker.

## Prohibitions
- No task execution logic
- No planning/orchestration logic
- No direct calls to aillium-core task APIs
- No storage of task state as source of truth
- No billing computation

## Allowed responsibilities
- Secure endpoint connectivity
- Session establishment for executors
- Device enrollment + grouping/tagging
- Audit-friendly logging and access controls

## Security requirements
- Restrict access to admin UI (allowlist/VPN)
- Enforce strong authentication
- Segregate tenants by groups/tags
- Record operator actions for audit
