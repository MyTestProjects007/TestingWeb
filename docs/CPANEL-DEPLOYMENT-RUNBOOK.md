# Shopademia cPanel Deployment Runbook

**Status:** planning only; no deployment or cPanel change is authorized by this document.
**Production:** **NO-GO** until the prerequisites and release gates below are independently verified.

## Verified repository facts

- `package.json` requires Node.js `>=20`; its supported start script is `npm start`, which runs `node server/index.js`.
- The server reads Passenger-compatible `PORT` (default `3000`), optionally binds `HOST`, and starts one Express application. It does not select different applications based on the request hostname.
- The application implements `/healthz`, `/admin`, `/admin/platform`, `/api/v1/*`, and the storefront/static asset routes in the same process. `/api/v1/healthz` is not implemented; health is `/healthz`.
- PostgreSQL is accessed through `DATABASE_URL` using the `pg` package. The runtime pool uses a 5-second connection timeout, a 15-second statement timeout, and a maximum of 10 connections. Set `DATABASE_SSL=true` only if required by the provider and supported by its CA configuration.
- `DATABASE_SSL` accepts only `true`, `false`, `1`, or `0` (or unset); any other value now fails both server startup and the standalone migration job rather than silently selecting plaintext. Startup configuration failures report the setting name and a safe validation message without logging the connection URL or secret values.
- Uploads are served at `/uploads`. By default they are written beneath `<application-root>/uploads`; `UPLOADS_DIR` can select an absolute persistent directory outside a versioned release. Startup creates the configured directory (except read-only preview mode, which requires it to exist). The path, durability, ownership/permissions, quota, and backup coverage must be confirmed with the provider; replacing application files must not replace or empty it.
- Production requires HTTPS `PUBLIC_SITE_URL` and `ADMIN_SITE_URL`; `ADMIN_SITE_URL` must be the admin subdomain of `PUBLIC_SITE_URL`. Admin browser sessions use the configured admin origin and secure cookies in production.
- Production startup requires `DATABASE_URL`, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `PUBLIC_SITE_URL`, and `ADMIN_SITE_URL`. `UPLOADS_DIR` is optional for local/default operation but should be set to an independently confirmed persistent absolute path for staging or versioned releases; the staging preflight requires it and rejects a path inside the package. The other optional runtime settings are `PORT`, `HOST`, `TRUST_PROXY_HOPS`, `DATABASE_SSL`, `DELIVERY_ADVANCE_CHARGE`, `ADMIN_SETTINGS_ENCRYPTION_KEY`, and the three `WEB_PUSH_VAPID_*` variables (which must be supplied together). `ADMIN_EMAIL` and `ADMIN_PASSWORD` are used by non-production initialization, not as a production administrator-reset mechanism.
- `server/migrate.js` is a separate production-only migration job and requires `MIGRATION_DATABASE_URL`. Do not run it as part of an unapproved deployment.
- The repository production-config validator and example are designed for its Docker Compose deployment: they require the private `database:5432` service and Compose role/database names. They are **not** an approved cPanel template and cannot be copied unchanged to cPanel.

## Existing hosting observations (read-only; 2026-10-20)

- cPanel showed home `/home/shopadem`, app directory `/home/shopadem/shopademia-app`, storefront document root `/public_html`, and separate document roots `/admin.shopademia.store` and `/api.shopademia.store`.
- A later read-only cPanel Terminal check confirmed `/home/shopadem/shopademia-app` contains `package.json` and `server/index.js`; the package declares Node `>=20` and `npm start` -> `node server/index.js`. The cPanel-provisioned Node 20 executable is `/home/shopadem/nodevenv/shopademia-app/20/bin/node`; system `node`/`npm` are not on the account shell's default `PATH`. Setup Node.js App showed the apex app as production/started on v20.20.2, while Application Manager showed no applications. These observations confirm registration/runtime availability, not request routing or process health.
- Read-only Terminal inspection found the API document-root `.htaccess` declares Passenger applications at the absent roots `/home/shopadem/shopademia/backend` and `/home/shopadem/shopademia_api/backend`, with absent Node 22 executable paths and `server.js` startup files. These declarations do not match the registered Node 20 app root and `server/index.js`; no routing changes have been made. The admin document-root `.htaccess` contains `Options -Indexes`, with no top-level HTML/PHP index file, consistent with a static document-root 403 if the web server uses it. Provider confirmation is required for effective vhost handling and any supported shared-app mapping.
- cPanel showed an account PostgreSQL database named `shopadem_shopapp` and an assigned account user. Neither the database's relationship to the live app nor its connection endpoint, version, schema, or effective privileges are verified.
- Previously recorded public requests returned 200 for the storefront and apex `/healthz`/catalog endpoint, 403/404 for admin, and timed out on API-host health requests. Sanitized archived access logs only reach Oct 16 and are not request-correlated with the Oct 20 failures; their old statuses do not independently verify the current public result or cause.
- Passenger restart-marker INFO entries were visible for the apex host. They do not prove a live process or correct upstream routing.

## Candidate mapping (must be confirmed by the host)

All three TLS virtual hosts must route to the **same** managed Express application and its app root:

| Public host | Express path served by that application | Expected function |
|---|---|---|
| `shopademia.store` | `/`, `/healthz`, `/api/v1/*`, static assets | Storefront, public API, readiness |
| `admin.shopademia.store` | `/admin`, `/admin/platform`, `/api/v1/admin/*`, `/uploads/*` | Admin UI, authenticated admin API, uploaded images |
| `api.shopademia.store` | `/healthz`, `/api/v1/*` | Readiness and documented API paths |

This is a proposed mapping from repository routes, not evidence that cPanel supports or currently applies it. The app itself does not mount an `/api/v1/healthz` route or distinguish these hosts. Confirm whether the provider can route each virtual host to one Passenger process while preserving the original host and HTTPS scheme. Do not use a static document root alone as a substitute for routing requests to Express.

## Deployment prerequisites — all must be satisfied before an approved change

1. **Provider capability:** written confirmation that the current plan supports Node.js 20 or newer, Passenger or an equivalent persistent process manager, application startup from `server/index.js` under the app root, dependency installation including native `sharp`, and secure protected runtime environment variables.
2. **Routing:** provider-confirmed effective vhost/upstream mapping for all three hosts, request-correlated logs for the current admin/API failures, and a documented, reversible routing change.
3. **Database:** owner/DBA independently verifies the authoritative PostgreSQL target, server/version, application role, schema compatibility, effective least-privilege grants, TLS requirements, and the supported connection path from the app process. Never infer target identity from the database name. Do not use cPanel database credentials until authorized and identity-verified.
4. **Recovery:** a complete database and uploads backup with timestamp, scope, integrity/checksum evidence, retention, and secure retrieval; plus a successful isolated restore and rehearsed app/database/uploads/config rollback with owner-approved recovery objectives.
5. **Application config:** produce a provider-specific configuration from verified facts; do not reuse the Docker-only `.env.production.example`. Inject secret values only through the provider's protected mechanism. Do not put secrets in the repository, ticket, chat, shell history, or public web root.
6. **Release authorization:** owner approves the exact immutable application release, host/routing changes, database actions (if any), validation plan, and rollback plan in writing.

## Local package and staging preflight

The repository provides a deterministic, dependency-free deployment package builder. From the repository root:

```sh
npm run package:deployment
node scripts/deployment-package.js verify release-artifacts/shopademia-cpanel-<package-id>
```

The builder emits a directory under the ignored `release-artifacts/` path. It contains the application entrypoint/import graph, runtime HTML/assets, package manifests, the value-free `deployment/cpanel.env.example`, this runbook, and the staging preflight tool. It excludes `.env*` files, Git data, tests, `node_modules`, uploads, backups, caches, and other non-allowlisted paths. `MANIFEST.json` records every packaged path, size, and SHA-256; the package identifier is derived from the sorted manifest entries. It will not overwrite a conflicting existing artifact. Do not upload the local artifact until provider/database/recovery prerequisites and exact release authorization are met.

On a separately approved isolated staging host, after installing dependencies with the provider-supported Node/npm versions, supply the configuration through the protected environment mechanism and run:

```sh
npm ci --omit=dev
npm run preflight:staging -- <deployment-package-directory>
```

The preflight verifies artifact integrity, Node >=20, npm compatible with lockfile version 3, staging-only HTTPS storefront/admin origins, and the presence/shape of required configuration without printing values. `DATABASE_URL` must not contain query parameters or a fragment: node-postgres connection-string options can override the visible endpoint, so any such suffix is rejected. It requires `UPLOADS_DIR` to be absolute and outside the packaged release directory, but cannot prove that the provider actually makes it persistent or writable. It performs **no** network/database request or migration. Its “NOT VERIFIED” external gates must still be satisfied with independent evidence: provider-confirmed runtime/routing and durable uploads storage, verified staging PostgreSQL identity/grants, verified backups and isolated restore/rollback, isolated synthetic-data/no-live-payments-and-notifications controls, and monitoring plus explicit change authorization. Passing this local preflight is not permission to deploy and does not establish operational staging readiness.

## Proposed execution sequence (not authorization to execute)

1. Agree on a private, non-production staging target. Use synthetic data, separate credentials/uploads, and disabled real payments/customer notifications. Verify the provider's process manager and all three test host routes there first.
2. Record the current document roots, routing configuration, application file inventory, upload inventory, PostgreSQL identity/grants, and provider logs without modifying them.
3. Create and verify recoverable backups. Preserve the existing app directory, public files, uploads, database, and unrelated cPanel settings. Prepare a separate immutable release directory rather than unpacking over the live app.
4. Install the lockfile-defined production dependencies with the provider-supported Node 20+ environment. Configure app root `/home/shopadem/shopademia-app` (or an approved versioned release root), startup file `server/index.js`, and the supported start mechanism (`npm start` / `node server/index.js`). Supply `PORT` from Passenger; do not hard-code a public interface or port.
5. Configure required environment variable **names** above through the protected cPanel/host mechanism. Validate configuration without printing values. Set `TRUST_PROXY_HOPS` only to the independently confirmed proxy hop count; incorrect trust settings can undermine secure-cookie and client-IP behavior.
6. Keep uploads on the existing persistent path or move them only under an explicitly approved, verified copy-and-rollback plan. Confirm the process owner has the minimum required filesystem access.
7. Apply approved PostgreSQL migrations only as a separately authorized operation after backup verification and review of the exact migration. Production `npm start` does not initialize or migrate the schema.
8. Route each host to the approved Passenger app only after a reversible change plan and authorization. Do not change DNS as a substitute for routing.
9. Validate HTTPS and certificate chains; `/healthz` (including PostgreSQL readiness), storefront, `/api/v1/products?limit=1`, admin page/login/session flow using the authorized test account, admin APIs, uploads, and API-host routes. Confirm expected status/content and inspect request-correlated Passenger/web-server/app logs. Never place real orders or trigger real payments/notifications as smoke tests.
10. Retain the previous release and the verified backup until owner acceptance. If any check fails, restore the previous app/routing configuration using the rehearsed procedure. Database rollback is not automatic: only perform a separately tested, explicitly approved database recovery plan. Preserve uploads and confirm database file references before resuming service.

## Current blockers

- The supported effective mapping from admin/API hosts to the registered Node 20 app, process health, and request-correlated current failure cause remain unverified. The API Passenger declarations are mismatched; do not edit them until the provider confirms supported routing and a rollback procedure.
- Protected production environment controls, secret-entry safety, and an authorized JWT rotation path remain unverified.
- The live app's PostgreSQL host, database identity, version, schema, and effective privileges are unverified.
- Backup integrity/coverage, isolated restore, uploads recovery, and rollback rehearsal are unverified.
- No provider-specific environment configuration or isolated staging validation exists.
- No exact production change has been approved.

**Do not deploy, upload, change routes/DNS/settings, run migrations, restore data, restart services, or change credentials until each relevant prerequisite is evidenced and the owner explicitly authorizes the exact action.**
