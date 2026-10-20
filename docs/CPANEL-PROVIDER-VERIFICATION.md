# Shopademia cPanel Provider Verification

**Purpose:** obtain technical facts before planning a production change. This is an investigation request only; it authorizes no changes.
**Account/application:** cPanel home `/home/shopadem`; application `/home/shopadem/shopademia-app`.
**Production status:** **NO-GO**.

Please answer each item in writing, distinguish included plan capabilities from paid upgrades or unsupported features, and provide the exact documented steps and relevant request/log references. Do not make changes to files, routes, DNS, databases, credentials, services, or hosting configuration.

## Current observations (2026-10-20)

- cPanel lists the storefront at document root `/public_html`, admin at `/admin.shopademia.store`, and API at `/api.shopademia.store`.
- Latest cPanel control observation (2026-10-20 08:09 +06): Application Manager loaded and reported “The system could not find any applications.” Setup Node.js App separately listed `shopademia.store/`, application root `/home/shopadem/shopademia-app`, mode `production`, status `started (v20.20.2)`. This confirms a Node.js app registration/status in that interface, but not process health, startup file, effective vhost routing, or the cause of the admin/API failures. No Edit, stop, restart, or delete control was used; no environment values were opened.
- Subsequent read-only cPanel Terminal checks (2026-10-20 08:19–08:44 +06) confirmed that the application root contains `package.json` and `server/index.js`, and the cPanel Node 20 environment includes `/home/shopadem/nodevenv/shopademia-app/20/bin/node`. The account shell does not have `node` or `npm` on its default `PATH`; the package declares Node `>=20` and `npm start` as `node server/index.js`. A process listing showed an `lsnode` launcher but did not prove application health or request mapping.
- The API document-root `.htaccess` contains two Passenger declarations referencing nonexistent roots `/home/shopadem/shopademia/backend` and `/home/shopadem/shopademia_api/backend`; both reference absent Node 22 executables and `server.js`. These do not match the registered app root, Node 20 runtime, and `server/index.js`. The admin document-root `.htaccess` contains `Options -Indexes`; no top-level `index.html`, `index.php`, or `index.htm` was present. If the admin vhost serves that directory statically, the root has no index and directory listing is disabled, consistent with HTTP 403. The effective vhost behavior is not independently confirmed.
- Sanitized route/status-only archived access-log summaries (no IPs, query strings, or user data emitted) show admin `/` HTTP 200 records on Oct 12–16, and API `/` HTTP 500/404 records on Oct 10 followed by HTTP 200 records on Oct 13–16. They predate the Oct 20 public failures and do not correlate to the current timeout/403; no matching API health-path record was found.
- The cPanel Tools page also reported one resource-level `401 (Access Denied)` in its browser console at 08:09:20 +06; the Tools, Application Manager, and Node.js pages subsequently rendered. The resource URL and cause were not shown, so this is not evidence that the whole cPanel session expired or that a permission restriction caused the public failures.
- Previously recorded public GET observations (2026-10-20 03:23 +06): storefront `/` and `/healthz` returned HTTP 200; admin `/` returned 403; API `/api/v1/healthz` timed out without an HTTP response. Earlier recorded observations also included admin `/admin` 404 and same-origin product API success. TLS certificate verification succeeded on completed TLS connections. These symptoms do not identify the active handler or root cause and were not repeated in this recheck.
- The cPanel PostgreSQL Databases page lists `shopadem_shopapp` (displayed size 8.54 MB) with `shopadem_shopuser` in its “Privileged Users” column. This establishes only the cPanel listing/association; effective PostgreSQL role attributes, memberships, grants, schema/migration state, server identity/version, and whether the live app connects to this database remain unverified.

## Questions requiring explicit answers

1. **Plan and Node capability**
   - Which Node.js versions are supported on this account? Is Node.js 20 or newer available?
   - Is this account permitted to create and run a persistent Node.js application? Is Phusion Passenger enabled for this account and plan?
   - If the cPanel Node.js controls are unavailable/disabled, what exact account, package, license, or server-side condition causes that state? Is an upgrade required?

2. **Application configuration and operations**
   - What application root, startup file, and startup command are supported for an Express app? Can the existing `server/index.js` be launched with `npm start`?
   - How are environment variables stored and injected through a protected mechanism, without putting secrets in the web root or shell history?
   - What exact action restarts/reloads the app? Does Passenger start it on demand, and what process/time/resource limits apply?
   - Where are the Passenger, web-server, application stdout/stderr, and request-correlated error logs? How long are they retained?
   - Are dependencies requiring native modules, including `sharp`, supported on the available runtime?

3. **Effective routing and proxy behavior**
   - Provide the effective TLS virtual-host, document-root, and upstream/process mapping for `shopademia.store`, `admin.shopademia.store`, and `api.shopademia.store`.
   - Explain why Application Manager reports no registered applications while Setup Node.js App lists the apex application as started on Node.js 20.20.2. Confirm which interface/process owns each hostname and whether the two interfaces refer to the same Passenger service.
   - Can all three hosts route to one supported Express process while preserving the original `Host`, HTTPS scheme, and required path behavior? If yes, provide the exact supported configuration method and any limitations.
   - Are reverse-proxy/rewrite rules and HTTPS termination supported for these domains? What `PORT`/forwarded-header and `TRUST_PROXY_HOPS` behavior should the app use?
   - Are WebSockets supported? The current app does not require WebSockets; please identify any limitation only if relevant.
   - Using request-correlated web-server, Passenger, and application logs, what confirmed cause (if any) explains admin `/` HTTP 403, admin `/admin` HTTP 404, and the API-host timeouts? Separate confirmed findings from hypotheses. Please identify which host/path and timestamp each log entry correlates with.
   - Please specifically verify whether the API vhost loads the account's API-root `.htaccess`; if it does, explain how the two Passenger declarations for absent application roots, absent Node 22 executables, and `server.js` are handled. Confirm whether the admin vhost serves its current static root (with `Options -Indexes` and no index file) or routes to the registered Node 20 app.

4. **Uploads and persistence**
   - Does the plan provide writable, persistent storage for the app's `uploads` directory across application restarts and deployments? State the supported path, ownership/permission requirements, quota, and backup coverage.
   - Can the app use a versioned release directory while keeping uploads and other persistent data separate?

5. **PostgreSQL access and identity**
   - What PostgreSQL server/version is supported for this account, and what hostname/port must an application process on this host use?
   - Can this app connect to the existing cPanel database `shopadem_shopapp` from the Node runtime? Do not infer that it is the authoritative live application database from its name.
   - What protected method lets the owner/DBA independently verify the actual target database, server identity/version, schema, effective runtime-role grants (including inherited and `PUBLIC` privileges), and network access without disclosing passwords in this ticket?
   - Can PostgreSQL connections use TLS with certificate verification? State supported requirements and CA handling.

6. **Backups and rollback**
   - How can the owner obtain protected backups of both PostgreSQL and application uploads? State scope, schedule, retention, secure retrieval, and whether integrity/checksum verification is available.
   - Can the provider support an isolated restore into a separate database and directory without touching production? What documented steps and limits apply?
   - Can the app files, virtual-host routing, database, and uploads be rolled back independently? State the supported rollback process and any provider assistance required.

7. **Classification and escalation**
   - For each capability above, label it **included**, **paid upgrade** (identify plan/price reference), or **unsupported**.
   - If another team owns Passenger, routing, or PostgreSQL, please escalate this request and return the receiving team's reference and any findings already available.

No credentials, connection strings, customer records, or customer-upload data are requested. Please do not perform a production change, database mutation, migration, restore, restart, or destructive operation. The owner will separately approve any exact proposed change after reviewing the evidence and recovery plan.
