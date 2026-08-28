# ADR-0003: V3 Authorization Model

- Status: Accepted
- Date: 2026-08-27

## Context

V2 only distinguishes organization `admin` and `member`, and does not fully specify invitations, seat assignment, adjustable role permissions, resource-level access, personal-device isolation or Workspace invalidation. Authorization must be explicit before V3 service and client work begins.

## Decision

1. Authorization is evaluated server-side for every request using authenticated user, current user status, organization status, active membership, role, resource ACL, subscription feature and quota.
2. Organization identity is explicit in the URL path. Client Workspace selection is never an authorization claim.
3. V3 has only preconfigured `admin` and `member` roles. Each organization can adjust their permission mappings; a server-enforced catalog prevents organization roles from granting personal-data, Platform Admin or cross-organization access. At least one active admin must retain `role.manage`.
4. A user becomes an active member only by accepting an email-bound, expiring invitation and receiving capacity in the same transaction; Phase 1 uses `seat_limit`, Phase 2 uses a seat row.
5. Restricted resource ACL is `read` or `write`; it only applies to active members and cannot grant organization administration or personal-data access.
6. Organization roles cannot access or manage another user's devices, sessions, private connections, private E2E data or local credentials.
7. Phase 2 onward, privileged organization or platform actions write an audit record without credentials or decrypted content.
8. The default client behavior is no persistent organization-resource offline cache. Loss of membership or organization access clears in-memory organization data immediately.

## Consequences

- Service and database work must provide transactionally safe invitation, seat and membership transitions.
- Every organization endpoint needs a shared authorization guard rather than ad hoc role checks in handlers.
- Platform administration remains distinct from organization administration and must use separate audited routes.

## References

- [V3 Implementation Specification](../v3/实施规格.md)
- [ADR-0002](./0002-v3-personal-organization-boundaries.md)
