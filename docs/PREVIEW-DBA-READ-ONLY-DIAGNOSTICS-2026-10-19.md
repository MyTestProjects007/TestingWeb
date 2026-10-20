# Shopademia Preview PostgreSQL — Read-Only DBA Diagnostic Package

**Status:** prepared, not executed. This package authorizes no database mutation.
**Intended endpoint/database:** `127.0.0.1:55441` / `shopademia_browser_preview`
**Candidate runtime role:** `shopademia_preview_ro`

## Hard limits

- Use only an already authorized local DBA connection mechanism for the marked isolated preview cluster. Do not guess credentials, use the application or integration-test role, inspect unrelated credential stores, or connect to port `5432`.
- Before running the diagnostic script, the DBA must independently confirm that the approved protected connection/service is mapped to the intended preview cluster. The script's first SQL statement is a second gate: it checks the live database name, server address, and port. If any differ, it stops before running catalog diagnostics.
- The script starts a `READ ONLY` transaction and runs catalog/privilege `SELECT`s only. It ends with `ROLLBACK`. No DDL, DML, grant, revoke, role creation, or configuration statement is permitted.
- Do not change role attributes, grants/default ACLs, passwords, protected configuration, or services based on these results. Any such change requires separate owner authorization after the report is reviewed.
- Do not include credentials, connection URLs, environment values, customer records, order contents, or customer-upload data in the report. Role names, catalog ACLs, object names, server version and the requested loopback endpoint are acceptable. Keep the raw output in an appropriately protected local location.

## Execution order

1. Confirm the owner has supplied an approved DBA connection/service for the isolated preview cluster. Independently confirm its configured target from the approved local administration record. Do not infer target identity merely because a listener is open.
2. From the repository root, invoke `psql` via that approved service without putting credentials in command arguments, shell history, or this repository. For example, substitute only the DBA-approved service name:

   ```text
   psql -X --no-psqlrc -d "service=APPROVED_PREVIEW_DBA_SERVICE" --file "scripts\preview-read-only-diagnostics.sql"
   ```

   The service configuration and authentication must be provided through the authorized protected mechanism; do not create one or alter credentials under this diagnostics authorization.
3. Confirm the script prints `Target identity gate passed: shopademia_browser_preview at 127.0.0.1:55441.` If it exits at the gate or reports another identity, stop and preserve the exact redacted error. Do not rerun against another endpoint.
4. Capture the remaining result sets, note the script exit code, and verify it prints `Diagnostics finished. Read-only transaction rolled back; no DDL or DML was permitted.` If a query errors, stop; report the exact query label/error with secrets redacted. Do not try alternate credentials or endpoints.
5. Complete the report template below and return it to the owner/code maintainer. This package itself does not authorize remediation.

The SQL is in [preview-read-only-diagnostics.sql](../scripts/preview-read-only-diagnostics.sql). The psql script checks the endpoint in its first query, exits with status 3 on mismatch, and only then proceeds to catalog inspection in the same read-only transaction.

## Result interpretation and stop conditions

- **Identity:** gate requires exact database name `shopademia_browser_preview`, address `127.0.0.1`, and port `55441`. Record the current DBA identity separately from the candidate runtime role; a DBA's privileges do not prove the runtime role's effective privileges.
- **Candidate role:** if `shopademia_preview_ro` is absent, candidate-only result sets will be empty/null. This is not authorization to create it. If present, expected attributes are LOGIN, non-superuser, NOINHERIT, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; it must have no direct or transitive role memberships.
- **Database:** candidate may need CONNECT, but must not own the database, have CREATE, or have effective TEMP. TEMP is independent from schema CREATE, may arrive through `PUBLIC`, and cannot be denied to one role while retained for other roles through a per-role `REVOKE`. A true effective TEMP result is a blocker; do not revoke from `PUBLIC` under this authorization.
- **Schemas/search path:** candidate needs `USAGE` on `public` and no CREATE. Its stored database/role settings are shown, but the DBA session's `current_schemas(false)` is not the candidate's live effective search path. The fail-closed app verifier must later confirm `current_setting('search_path') = 'public'` and `current_schemas(false) = ['public']` on a fresh candidate-role connection; this also rejects unresolved entries such as `$user`.
- **Tables/views/columns:** effective grants via direct ACL, `PUBLIC`, and inherited roles must be limited to SELECT on reviewed required query dependencies. The verifier checks the exact source-derived read-column allowlist in [readOnlyPreview.js](../server/readOnlyPreview.js): `schema_migrations`, `shops`, `managed_products`, `shop_product_categories`, `shop_hero_slides`, and `shop_offers`. Each required dependency must be an ordinary or partitioned table (`relkind` `r` or `p`); a view, materialized view, or foreign table cannot satisfy the read allowlist. The diagnostic relation inventory includes `relation_kind` to identify these cases. The verifier rejects effective SELECT on any other user-schema column, including through a table-level grant, and fails if required read columns lack SELECT. No relation/column write, TRUNCATE, REFERENCES, or TRIGGER privileges and no preview object ownership in any non-system schema. The verifier evaluates all non-system schemas, not just `public`, because schema-qualified objects remain addressable outside the effective search path. Do not introduce a view-backed preview dependency without separately reviewing its definition/options and changing the verifier and source-derived allowlist.
- **Sequences:** no sequence privilege is expected for current approved read queries in any non-system schema; reject SELECT, USAGE, UPDATE, and ownership. Do not grant sequence access without a source query that requires it.
- **Routines:** reject effective EXECUTE on any custom routine in a non-system schema, including SECURITY DEFINER routines; the updated guard checks this. The application uses PostgreSQL built-ins and does not need custom routines. The diagnostic still reports routine kind, security-definer status, and effective ACLs for review.
- **Default ACLs:** existing rows only show customized default ACLs; PostgreSQL's built-in defaults may apply when no row exists. Defaults are per object-creating role, not inherited from membership at object-creation time, and do not affect existing objects. Schema-level defaults add to global defaults and cannot subtract global grants. Identify each actual migration/object creator; blanket future table SELECT may expose future sensitive tables and is not approved.
- **Schema compatibility checks:** verifier-required admin/order columns are checked through catalogs only. Their presence does not imply permission to read their data. `admin_settings` is not needed: preview announcement uses the static default and does not query that table.
- **Missing row, unexpected privilege/owner/membership, unexpected schema path, executable custom routine, or SQL error:** STOP, report it, make no changes, and do not restart the preview.

## Current source-reviewed application reads

Before DBA grants are designed, re-check the current source because these dependencies change with code:

- `schema_migrations(version, checksum)` for startup integrity verification; catalog metadata / `pg_attribute` for required-schema checks.
- `shops`: storefront selection, shop profile/config, listing, site map, and public API reads. Current source reads `id`, `slug`, `name`, `status`, `advance_charge`, `description`, `location`, public contact fields, and public image fields.
- `managed_products`: catalog load at startup; current source reads product identity, name/description/SEO, price/old-price, category, image/images, availability/stock/archive, shop id, and creation time.
- `shop_product_categories`: current source reads shop id, category id/name/description/icon/active state.
- `shop_hero_slides`: current source reads shop id, id/position, images, headline/body/button/target.
- `shop_offers`: public offers read published/time-window/shop fields and public id/title/message/image fields.
- `orders`: no order-data read is required in read-only preview. The `/top-selling` page and API are excluded from the preview allowlist because PostgreSQL column-level `SELECT` on `items` would expose the complete JSON value, not only the product ID and quantity keys used by the aggregate. The verifier checks required order-column presence through catalogs only; that metadata check does not require `SELECT` on order data.

Use column-level SELECT grants where practical, after query review. Do not grant all columns on a table simply because the schema checker names that table. If top-selling is required in a future preview, first design and separately authorize a database-side aggregate view or equivalent that exposes only approved aggregates; do not grant the preview role access to `orders.items`. Exclude admin, order lookup, customer, mutation, and notification routes. `admin_settings` is specifically not required.

## Provider submission addendum (prepared, not submitted)

The existing provider request subject and body remain in [the deployment report](./PRODUCTION-DEPLOYMENT-REPORT-2026-10-19.md). Keep that wording intact and append the following timestamped observation:

> Fresh bounded HTTPS observations on 2026-10-19 at approximately 22:06 +06 (checks completed by 22:06:37 +06): requests to `shopademia.store/`, `/healthz`, and `/api/v1/products?limit=1` returned HTTP 200 from `122.173.84.249`; `admin.shopademia.store/` returned HTTP 403 and `/admin` returned HTTP 404; `api.shopademia.store/healthz` returned no response within 10 seconds (HTTP 000, curl exit 28). These are symptoms only; please correlate them with effective vhost/upstream mappings and request logs. No production state was changed.

The authenticated cPanel Tools page historically displayed **Billing & Support → Open Ticket**, but an HTTP 401 was observed for the support resource; the authenticated form was not verified. The account owner must authenticate through the normal cPanel UI, follow the visible **Billing & Support → Open Ticket** entry if available, submit the prepared request, and preserve its ticket number, timestamp/timezone, exact submitted text, attachments, provider response, request IDs, and correlated log timestamps. Until evidence is returned, status remains **PREPARED — NOT SENT**. Desired architecture is one Express backend shared by the storefront, admin, and API domains, subject to provider confirmation; do not infer that current hosting supports it.

## Redacted DBA report template

```text
Diagnostic date/time and timezone:
Authorized DBA/operator (name or approved identifier):
Approved connection/service reference (no credentials or connection string):
Command used (remove service secrets and any sensitive local paths):
psql exit code:
Identity gate: PASS / FAIL
Reported database / server address / port / server version:
Current diagnostic session role and transaction_read_only:
Candidate shopademia_preview_ro exists: YES / NO
Candidate role attributes (redacted as appropriate):
Direct / transitive role memberships:
Database owner; candidate CONNECT / CREATE / TEMP effective results:
Database ACL source for TEMP (direct / PUBLIC / membership / none / unresolved):
Schema owners; candidate public USAGE / non-system CREATE and ownership; stored path settings:
Candidate configured/effective search_path verified by app guard: NOT RUN (requires fresh runtime role connection)
Non-system relation/view/materialized-view owners and SELECT/write/DDL effective grants:
Column-level SELECT and write effective grants:
Required preview read dependencies compared with the source-reviewed list above: PASS / FAIL; list each missing required relation/column and each unexpected relation/column/privilege:
Non-system sequence owner and SELECT / USAGE / UPDATE results:
Non-system custom routines, SECURITY DEFINER status, effective EXECUTE:
Existing default ACL rows by actual object-creating role and object type:
Sensitive or unresolved views/routines/ACLs:
Errors (exact error text, with secrets removed):
No DDL/DML run: CONFIRMED / NOT CONFIRMED
No roles/grants/config/process changed: CONFIRMED / NOT CONFIRMED
Unresolved blockers and recommended owner decision:
```
