# ADR-0002: V3 Personal and Organization Boundaries

- Status: Accepted
- Date: 2026-08-27
- Supersedes: the personal-organization and cross-organization personal-entitlement portions of ADR-0001

## Context

V2 represents every user through a personal organization and derives private user limits from every active organization membership. That model makes a Team membership change private device, connection and E2E-sync limits, although the related data belongs to the user and is not owned by the organization. It also overloads connection groups, plans and subscriptions with incompatible personal and organization meanings.

## Decision

1. V3 separates personal and organization domains. A user owns a personal space; an organization owns a collaboration space.
2. V3 has no personal organization. Personal plans, subscriptions and orders use `user_id`; organization plans, subscriptions, orders and seats use `organization_id`.
3. The personal `free` plan is a mandatory current entitlement for every registered user. It is independent of organization membership, organization subscription, trial and seat lifecycle.
4. Devices, refresh sessions, personal E2E sync, private connection metadata and private history belong only to `user_id`.
5. An organization seat grants access to that organization's collaboration space only. It never grants or upgrades personal plan limits.
6. Organization resources are separate server-authorized resources. They may contain connection templates and shared queries, but never personal database passwords, SSH passwords, private keys, passphrases or E2E sync material.
7. The VS Code explorer uses an explicit Personal/Organization Workspace selector. Connection groups remain a personal Workspace presentation feature and must not represent organizations.

## Consequences

- Personal data remains intact when a user joins, leaves or is removed from an organization.
- Organization billing and resource quotas become explainable without silently altering private user limits.
- V3 has more tables than V2, but each table has one data owner and one entitlement source.
- V2 data and contracts are not migrated or preserved. V3 is Greenfield.

## References

- [V3 Implementation Specification](../v3/实施规格.md)
- [ADR-0003](./0003-v3-authorization-model.md)
