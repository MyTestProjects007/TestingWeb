# Shopademia Preview PostgreSQL — DBA Verification Handoff

**Status: BLOCKED — no authorized protected execution/service reference or DBA result has been supplied.**
**Approved target to verify before execution:** isolated preview only, `127.0.0.1:55441`, database `shopademia_browser_preview`.
**Candidate runtime role:** `shopademia_preview_ro`.

This handoff requests verification only. It does not authorize production access, database mutation, role/grant changes, remediation, or service restart.

## Required DBA procedure

1. Obtain the explicitly authorized protected DBA connection/service reference from the owner. Do not guess credentials, inspect credential stores, use application/integration credentials, or place credentials/connection strings in chat, repository files, shell history, or the returned report.
2. Independently verify from the approved protected service configuration that the connection targets the isolated preview environment. Do not infer identity from a database name or an open listener.
3. Only after that independent check, execute **only** [`preview-read-only-diagnostics.sql`](../scripts/preview-read-only-diagnostics.sql), following the full procedure in [`PREVIEW-DBA-READ-ONLY-DIAGNOSTICS-2026-10-19.md`](./PREVIEW-DBA-READ-ONLY-DIAGNOSTICS-2026-10-19.md). The SQL performs its own exact database/address/port identity gate, begins a `READ ONLY` transaction, runs catalog/privilege reads, and ends with `ROLLBACK`.
4. If either identity check fails, stop immediately. Do not try another endpoint/service or alternate credentials. Return the redacted identity mismatch/error and do not run catalog queries.
5. Return the diagnostic date/time and timezone, approved service reference identifier (not credentials), psql exit status, identity-gate result, PostgreSQL version, candidate role attributes/memberships, owners and effective database/schema/table/column/sequence/routine privileges including inherited and `PUBLIC` access, search-path settings, and the source-reviewed preview dependency comparison. List missing required and unexpected relation/column/privilege access and exact errors with secrets/sensitive values redacted. Confirm whether any DDL/DML, role/grant, configuration, or service changes occurred; expected answer is none.

Do not return passwords, full connection URLs, environment values, customer/order data, or upload contents. Keep raw output in an appropriately protected location.

## Current evidence and blocker

The repository contains the read-only SQL and the detailed DBA procedure/report template, but no authorized service reference or redacted diagnostic results have been provided. No database connection or query has been attempted by this handoff. Until the owner supplies an explicitly authorized protected service and an independent target check is possible, **live preview DB verification remains BLOCKED**. No production database may be used for this diagnostic.
