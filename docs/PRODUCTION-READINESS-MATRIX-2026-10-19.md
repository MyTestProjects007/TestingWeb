# Shopademia Production Readiness Matrix

**Reassessed:** 2026-10-19 22:26 +06
**Repository:** `feature/admin-v2`, commit `ae67305f08051e88b4fcfb2cd1b716df6a968636`
**Intended remote:** `AbidHossainTushar003/LiveShopademia`, `feature/admin-v2`
**Overall verdict:** **PRODUCTION NO-GO — DEPLOYMENT BLOCKED**

“PASS” is limited to the evidence and scope stated. A public HTTP 200 or successful source-level test does not establish a complete production deployment.

## Requirement-to-evidence matrix

| Area | Status | Evidence and limitation | Next safe action |
|---|---|---|---|
| Release source | PASS (source/CI only) | Local HEAD and intended GitHub branch both match `ae67305f08051e88b4fcfb2cd1b716df6a968636`; exact-SHA CI run `39247003547` passed. CI is not deployment evidence. | Preserve the reviewed commit; determine the live SHA only through an authorized host check. |
| Storefront host | PASS (limited) | Fresh bounded public GETs at approximately 2026-10-19 22:06 +06 returned HTTP 200 for `/`, `/healthz`, and same-origin `/api/v1/products?limit=1` from `122.173.84.249`. Live SHA and functional browser flows remain unknown. | Provider/account owner confirms ownership and effective vhost; independently verify routing and full database-backed flows in isolated staging. |
| Admin host routing | FAIL — HOST CONFIG; LISTING CONTAINMENT PARTIAL | Fresh bounded GET at approximately 22:06 +06: `/` returned 403 and `/admin` 404 from `122.173.84.249`. Earlier cPanel Indexes evidence (17:17–17:38 +06) reports **No Indexing** selected and bounded requests to visible entries returned 403; this is not a fresh setting read at 22:06. Effective mapping remains unknown. | Preserve No Indexing. Provider confirms the active admin vhost/root/upstream and logs; owner verifies the current cPanel setting and routes without opening unintended files. |
| API host routing | FAIL — UPSTREAM/VHOST UNKNOWN | Fresh bounded GET at approximately 22:06 +06: `/healthz` returned HTTP 000 after 10.004 s, curl exit 28, zero response bytes from `122.173.84.249`. The apex-host health/catalog API responds. | Provider supplies API vhost/upstream/listener and correlated logs; independently repeat bounded health and API workflow checks after an approved routing fix. |
| DNS | PASS (limited) | All three A records resolved to `122.173.84.249`; the apex AAAA and admin/API CNAME queries returned no answer. Same IP does not prove correct host routing or ownership. | Confirm destination ownership and active vhost mappings through provider support. |
| TLS | PASS (limited) | TLS verification succeeded for storefront and admin HTTP responses; API negotiated HTTPS before timing out. Certificate success does not establish app routing. | Verify renewal and each host's application mapping after routing is corrected. |
| HTTP-to-HTTPS | PASS (limited) | Prior probe showed the storefront HTTP request ending at HTTPS; no fresh redirect behavior was needed to diagnose the current host routing. | Verify direct redirect status/headers after cutover. |
| Storefront/API code | PASS (source/unit scope) | Express routes, product/catalog repositories, server-priced order validation, and `GET /healthz` are present. Tests use fake pools for most API cases. | Validate real PostgreSQL behavior only against an explicitly isolated, marked test database. |
| Product shop isolation / SEO-001 | PASS (source/regression scope) | The server-rendered product route resolves `findProductForShop`; new test confirms another active shop cannot render the main-shop product's metadata. | Retain this regression test. |
| Admin authentication | BLOCKED (production) | Source includes login, token/session controls, production MFA enforcement, HttpOnly/Secure/SameSite=Strict cookies and same-origin checks; the public admin host does not reach that app. | Correct host routing, then test with an authorized synthetic staging identity. |
| Customer orders/payment | PASS (test/source scope only) | Unit/API tests cover server-side prices, validation, idempotency, and order flows. README states payment collection is manual; no bKash API integration exists. | Test only in isolated staging with synthetic data; do not place a live order. |
| PostgreSQL production state | BLOCKED — IDENTITY/GRANTS | Historical authenticated cPanel inventory lists `shopadem_shopapp` (8.54 MB) and `shopadem_shopuser`; the running app's `DATABASE_URL`, schema, records, role grants, and actual connected database were not read or independently verified. | Provider/authorized DBA confirms identity, version and effective grants through protected evidence; independently perform authorized read-only identity/grant checks. |
| Backup and restore | BLOCKED — RECOVERY | cPanel reported no automatic backups; partial Oct. 8 home/database downloads were offered. JetBackup showed snapshot records but its database/home categories had no backups. Nothing was downloaded or validated. `scripts/backup-production.sh` defaults to `.env.production` and `docker-compose.production.yml`, emits encrypted DB and uploads archives but no recorded checksum/manifest or joint consistency proof. `scripts/restore-production.sh` uses that production Compose file and creates a separate database in its configured database service; this is not evidence of a separately isolated restore host. Neither script was run. | Provider confirms supported complete point-in-time DB+uploads capture and separate restore infrastructure. Validate timestamps, versions, checksums, DB archive integrity, uploads archive integrity and DB-to-file references in isolation. |
| Rollback | BLOCKED — NOT REHEARSED | No verified prior release/config identity, independent recovery point, rehearsed app/database/uploads rollback, or owner-defined RPO/RTO evidence. | Define RPO/RTO and compatible rollback sequence; rehearse with isolated app, DB and uploads before any release. |
| Hosting runtime | PARTIAL — PASSENGER APEX ONLY; ROUTING/ARCHITECTURE BLOCKED | Historical authenticated cPanel Setup Node.js App reported one production Passenger app at URI `shopademia.store/`, root `/home/shopadem/shopademia-app`, Node `v20.20.2`, startup `server/index.js`, status `started`. cPanel Domains listed separate admin/API static roots and HTTPS forced. These screens do not prove live SHA, effective vhost/upstream, successful DB connection, admin/API mapping, or protected environment values (`ADMIN_SITE_URL` was absent from the displayed variable names). Docker/Compose/Caddy support remains unverified. | Provider identifies supported mapping from admin/API to this same Express app and proves runtime environment/log details; if unsupported, account owner decides an alternate architecture. No second backend or DNS guess. |
| Local test suite | PASS (isolated PostgreSQL integration included) | Latest full `npm test` on the marked local PostgreSQL 16.15 database: 170 passed, 0 failed, 0 skipped. Includes regressions rejecting port 5432, connection URL query/fragment overrides, a write-capable preview role, and the concurrent-oversell integration test. Post-test synthetic products/orders were confirmed cleaned up. | Keep integration access restricted to protected test config and port 55442; never target production or the unverified 5432 service. |
| Dependency audit | PASS (fresh local run) | `npm audit --audit-level=low`: 0 vulnerabilities reported. This is not a full source security review. | Continue normal lockfile and CI review. |
| Production configuration | BLOCKED | `.env.production` is absent; `npm run validate:production` refuses to proceed. Historical cPanel showed environment variable names only and did not show `ADMIN_SITE_URL`; no secret values were read. | Authorized operator verifies required variables and secret provenance privately in the effective Passenger or approved production runtime; do not create local production secrets. |
| Local browser/E2E | PASS — LIMITED LOCAL SCOPE | Empty read-only preview on `127.0.0.1:3002`: 16 passed, 0 failed, 3 fixture-dependent skips. Follow-up on a temporary loopback app backed by the marked isolated PostgreSQL test DB `127.0.0.1:55442`: all 19 `tests/e2e/storefront.spec.js` Chromium tests passed with synthetic catalogue fixtures; exactly 18 demo shops, 72 categories, and 576 products were transactionally removed and zero fixture/order rows remained. Privileged admin E2E was not run. | Run full product-backed and authorized admin integration/E2E coverage only in verified isolated staging; local-only success does not clear production gates. |
| Local read-only preview DB-role isolation | BLOCKED | The existing preview app/DB listeners are loopback-only, and app pool connections set `default_transaction_read_only=on`. A fresh ordinary-role inspection found its normal transaction setting is `off`, it has database/schema creation privileges, owns 23 public tables, and can write those tables. No authorized admin credential/configuration was found; the hardened verifier rejects the role. The currently running process was left unchanged and is NOT APPROVED FOR CONTINUED USE. | Account owner/DB administrator must provide an authorized local admin path to provision a dedicated non-owner role with only required `CONNECT`/schema `USAGE`/`SELECT`, no write/DDL grants, object ownership, creation rights, or role memberships; update protected local config and independently verify before restarting preview. |
| Android admin | BLOCKED / absent | Current HEAD contains no Android source. Commit `790a1305f3fde30aafcd6f0c5347d11ba3272d5d` deleted the prior `phone app` Gradle/source/test tree. | Decide/authorize whether the previously removed app should be restored; do not silently rewrite existing user history. |
| Legal/business policies | NOT TESTED | Prior [AUDIT_REPORT.md](../AUDIT_REPORT.md) records unresolved shop-specific fulfillment/refund terms, privacy-retention operations, and owner/legal review. | Obtain owner-approved policies and qualified local legal review. |
| Security review | BLOCKED / PARTIAL | Directory listing was contained by cPanel No Indexing; latest recorded admin root response was 403 without the directory-index marker. Earlier exposure is a Medium-severity information-disclosure/configuration incident; the listed `php.ini` was not opened. The prior audit's static-file realpath/open race remains theoretical/unverified. Dependency audit reports 0 advisories. | Keep No Indexing enabled; provider should confirm effective document root/read-only inspect for unintended files. Resolve the static-file concern only with evidence and focused reproduction. |
| Upload persistence/performance | BLOCKED | No production upload directory was inventoried; responsive-image and real network performance evidence is absent from the prior audit. | Inventory persistent files read-only and measure in staging before any storage change. |
| Secrets in Git | PASS (limited) | Environment files are ignored except documented examples; no production environment file is tracked. This check does not establish that historical secrets were never committed. | Rotate any previously exposed hosting password through the provider; use a dedicated history scan if needed. |

## Tests and artifacts

| Command or check | Result |
|---|---|
| `node --test --test-name-pattern="product metadata is not exposed under another shop route" server/app.test.js` | PASS — 1 passed |
| `npm test` | PASS — 169 total; 168 passed, 1 skipped, 0 failed |
| Skipped test | `PostgreSQL checkout reads current product state and prevents concurrent oversell`; it is explicitly opt-in and requires a loopback-only isolated database with marked database/role identity. No test identity was configured. |
| `npm audit --audit-level=low` | PASS — 0 vulnerabilities |
| Lint/type-check | NOT APPLICABLE — no lint or type-check script is defined in `package.json`. |
| Focused admin/routing tests | PASS — 3 tests passed for admin page/headers, configured admin origin, and staging domain-to-Caddy wiring. |
| Tailwind production CSS build | PASS — built to a temporary file with `npm exec -- tailwindcss -i css/tailwind.input.css -o "$env:TEMP\shopademia-tailwind-generated.css" --minify`; output content matched the checked-in CSS after line-ending normalization. The temporary output was removed; the repository artifact was not modified. |
| Caddy route regression assertions | PASS — added checks for storefront admin-path denial, admin `/admin` forwarding/root redirect, and API `/healthz` and public API forwarding. The focused staging-config test passed. |
| `npm run validate:production` | BLOCKED — `.env.production` is intentionally absent. |
| Playwright | BLOCKED — no isolated local preview; production targets are explicitly refused by the repository guard. |
| Android Gradle build/tests | BLOCKED — Android project is absent from current HEAD. |
| GitHub Actions | PASS — run [39230764949](https://github.com/AbidHossainTushar003/LiveShopademia/actions/runs/39230764949) for commit `0786d690983d615bf1ef655909872229bd903f18`; CI is not a production deployment. |

The Caddy route regression assertions are uncommitted local changes and were not part of CI run `39230764949`; the complete local test suite above includes them.

## Live domain observations

During the 2026-10-19 09:37 UTC reassessment:

- `shopademia.store`: `/`, `/healthz`, and `/api/v1/products?limit=1` returned HTTP 200 over verified HTTPS.
- `admin.shopademia.store`: HTTP 200 from LiteSpeed directory index (1593 bytes); `/admin` returned 404. The listing names only `cgi-bin` and `php.ini`; their contents were not opened.
- `api.shopademia.store`: TCP/TLS succeeded and HTTP request was sent, but no response bytes arrived within 10 seconds on `/healthz` or `/`.
- All three names resolved to `122.173.84.249`; the apex AAAA and admin/API CNAME queries returned no answer. This does not identify the actual virtual host or upstream.
- The integrated browser returned load failures for the storefront and admin; browser functional behavior therefore remains unverified.

The repository's Express `/admin` route and Caddy host-routing contract are present and covered by tests/config validation. The observations indicate a production vhost/proxy mismatch, not a reproduced application-route failure. Exact document root, API upstream, running process, and provider policy remain unknown without authorized host diagnostics.

## Release gate

**PRODUCTION NO-GO — DEPLOYMENT BLOCKED.** The storefront is partially available, but the admin host exposes a LiteSpeed directory index and fails `/admin`; the API hostname accepts an HTTPS request but sends no response. No application code defect or safe code-level remediation was established. Production database/uploads, verified backups/restore, rollback, supported runtime, deployed SHA, and isolated browser workflows remain unverified. No production changes were attempted.

## Minimum provider action

Send the hosting provider an authenticated support request asking them to (1) confirm Node 20+ persistent-process, Docker/Compose, Caddy ports 80/443, PostgreSQL and persistent-volume support; (2) identify the active document root and vhost/proxy/upstream for each hostname; (3) disable admin directory listing and inspect the webroot read-only without deleting files; (4) inspect API-host upstream/process logs for the no-response timeout; and (5) confirm protected environment-variable and backup/restore capabilities. Require written approval before any DNS, routing, file, database, or service changes. If the plan cannot run the repository's existing Docker Compose architecture, request an authorized Linux VPS rather than replacing the app/database.

Required before a production change: obtain the provider response and authorized host access; inventory persistent data read-only; create protected backups and prove restoration into isolation; document rollback; provision secrets on-host; verify isolated staging; then deploy a known, reviewed release and test all domains.

## Authenticated cPanel evidence update — 2026-10-19

This update supersedes earlier claims that cPanel runtime status and domain roots were unavailable. It does not supersede the production NO-GO verdict.

| Area | Latest verified evidence | Status / remaining gate |
|---|---|---|
| GitHub release and CI | GitHub API confirms `AbidHossainTushar003/LiveShopademia:feature/admin-v2` is at `0786d690983d615bf1ef655909872229bd903f18`; Actions run `39230764949` succeeded for this SHA. The local `github` remote points elsewhere; local investigation edits are uncommitted/unpushed. | PASS for source/CI only; not deployment evidence. |
| cPanel domain roots | cPanel Domains lists `/home/shopadem/public_html`, `/home/shopadem/admin.shopademia.store`, and `/home/shopadem/api.shopademia.store`, with HTTPS forced on each. | Verified roots; effective LiteSpeed/Nginx vhost and upstream settings remain unavailable. |
| Admin host and listing | Public response has `Server: LiteSpeed`; root returns a directory index, `/admin` returns 404. cPanel maps this host to its independent directory; visible entries are `cgi-bin` (0755) and `php.ini` (374 bytes, 0644). Contents and hidden entries were not inspected. cPanel Indexes is `Inherit`; `HEAD` to those paths returned 403. | FAIL — host/application mapping. No sensitive content exposure confirmed. cPanel offers **No Indexing**, but it was not applied. |
| API host and routing | API host has its own cPanel document root. Public `/healthz` received zero response bytes in a 10-second probe; authenticated browser showed HTTP 500 “Request Timeout.” No effective vhost/upstream or error log was available. | FAIL — exact timeout cause unknown. Provider must inspect host routing and logs. |
| Passenger / Node runtime | cPanel Setup Node.js App reports a single production Passenger app at URI `shopademia.store/`, root `/home/shopadem/shopademia-app`, Node `v20.20.2`, startup `server/index.js`, status `started`. | PARTIAL PASS — Node 20 app manager and apex app are verified; admin/API host mapping, live SHA, and database-connected health are not. |
| Runtime environment | cPanel showed environment-variable names only; values were not read. `DATABASE_URL` and `DATABASE_SSL` appear in the displayed list; source-required `ADMIN_SITE_URL` did not. | BLOCKED — host must verify effective configuration securely; no secret values should be placed in reports. |
| PostgreSQL | cPanel lists `shopadem_shopapp` (8.54 MB) and `shopadem_shopuser`. | PARTIAL inventory only — running app's connection target, schema, records, and authoritative production identity are unverified. |
| Backups and recovery | cPanel states there are no automatically generated backups; partial home-directory and database backup downloads dated Oct. 8 are offered. No backup was downloaded or restored; JetBackup provided no usable evidence. | BLOCKED — coverage, integrity, isolated restoration, uploads, and rollback remain unverified. |
| Logs / web-server configuration | cPanel Errors page navigation timed out; no application/error logs or effective vhost configuration were obtained. Public storefront/admin identify LiteSpeed; this does not rule out a proxy layer. | BLOCKED — provider support required to explain API timeout and provide supported host mapping. |
| Hosting architecture | Passenger/Node 20 is present for one app; PostgreSQL management UI is present. | PARTIAL — Docker/Compose/Caddy support and required persistent storage/backup capabilities remain unverified; no production deployment target is approved. |

Public outcomes remain separate: the storefront root, health check, and same-origin catalog API returned HTTP 200; admin root listed directory entries and `/admin` returned 404; API hostname did not return a response within the bounded probe. No code-level application defect explaining those host-specific results has been demonstrated, and no production changes were made. `PRODUCTION NO-GO — DEPLOYMENT BLOCKED` remains the only release verdict.

Latest local verification: `npm test` — 169 total, 168 passed, 0 failed, 1 opt-in PostgreSQL test skipped; `npm audit --audit-level=low` — 0 vulnerabilities; `npm run build:css` — PASS. An independent build to a temporary path was byte-for-byte identical to the generated stylesheet. Against baseline HEAD, generation removes only the unused `.isolate{isolation:isolate}` utility; no source uses the `.isolate` class, and the separate `isolation:isolate` CSS declaration remains. This generated artifact change is included in the candidate. `git diff --check` — PASS. These results do not establish live deployment or production recovery readiness.

## Fresh baseline recheck — 2026-10-19 16:19 +06

| Requirement | Status | Fresh evidence / limitation |
|---|---|---|
| Intended GitHub branch baseline | PASS (baseline only) | `git ls-remote` and GitHub branch listing both report `feature/admin-v2` at `0786d690983d615bf1ef655909872229bd903f18`. CI run `39230764949` succeeded for that SHA, not the subsequent local changes. |
| Storefront | PASS (limited) | Fresh HTTPS `/`: 200, HTML, 34,371 bytes, 0.435 s; `/healthz`: 200 JSON, 15 bytes, 0.264 s; `/api/v1/products?limit=1`: 200 JSON, 3,770 bytes, 0.260 s. `Server: LiteSpeed`; TLS verification succeeded. No browser customer-flow test. |
| Admin | FAIL | Fresh HTTPS `/`: 200 LiteSpeed HTML directory index, 1,593 bytes, 0.357 s. `/admin`: 404 HTML, 1,251 bytes, 0.239 s. cPanel's admin root remains separate from Passenger; Indexes remains `Inherit`; no production setting was changed. |
| API | FAIL | Fresh HTTPS `/healthz`: HTTP `000`, curl exit 28 after 10.013 s, zero response bytes and no content type. TLS/HTTP connection was made before timeout; effective upstream cause remains unknown. |
| DNS | PASS (limited) | All three A lookups returned `122.173.84.249`; this does not identify routing or origin ownership. |
| cPanel containment capability | PASS (control observed; not applied) | Indexes `No Indexing` states no files appear if no default file exists; current selection is `Inherit`. It does not route requests to Express. No setting was saved. |
| Recovery/deployment gates | BLOCKED | Running app's database identity, schema/data and upload inventory; complete backup integrity; isolated restoration; rollback; isolated staging; effective vhosts/logs; and production authorization remain unverified. |

Probes were certificate-validating HTTPS GETs with a 10-second maximum and redirect-following enabled; redirect counts were not captured. No live deployment, application restart, production file/database/upload/DNS mutation, commit, or push is established by this check. The two unrelated untracked files remain untouched. Verdict remains **PRODUCTION NO-GO — DEPLOYMENT BLOCKED**.

Current local suite and artifact checks: `npm test` — 169 total, 168 passed, 0 failed, 1 opt-in PostgreSQL test skipped; `npm audit --audit-level=low` — 0 vulnerabilities; production CSS build plus independent comparison — PASS; `git diff --check` — PASS.

## Published source and CI — 2026-10-19 16:25 +06

| Area | Status | Evidence |
|---|---|---|
| Candidate source | PASS (source only) | Commit `1ec245ca10a9d4c552b7718ad1ea6c7739ae108c` was pushed to `AbidHossainTushar003/LiveShopademia:feature/admin-v2`; GitHub branch SHA and `git ls-remote` match. |
| CI for candidate | PASS (CI only) | GitHub Actions run [39237231146](https://github.com/AbidHossainTushar003/LiveShopademia/actions/runs/39237231146) completed successfully for the exact commit above. No live deployment is implied. |
| Production | BLOCKED | Admin/API routing and production recovery/authorization gates remain unresolved; no production change was made. |

## Latest audit refresh — 2026-10-19 16:41 +06

| Area | Status | Latest evidence and limitation |
|---|---|---|
| Intended GitHub source and CI | PASS (source/CI only) | The audit snapshot `affc95fbe515a5d2ed86a16bcd651f1d67b3f127` is pushed to `feature/admin-v2`; CI run [39239950754](https://github.com/AbidHossainTushar003/LiveShopademia/actions/runs/39239950754) succeeded for this exact SHA. This is not deployment evidence. Local tracking points to a different repository; the intended GitHub ref was checked independently. |
| Storefront hostname | PASS (limited) | HTTPS `/` returned 200 HTML (34,371 bytes, 0.338 s); same-origin `/api/v1/products?limit=1` returned 200 JSON (3,770 bytes, 0.257 s). Both identified LiteSpeed; TLS verified. Full browser customer journeys and live release SHA are unknown. |
| Admin hostname | FAIL — host mapping/indexing | HTTPS `/` returned 200 HTML (1,593 bytes, 0.261 s); `/admin` returned 404 HTML (1,251 bytes, 0.262 s). cPanel maps the hostname to a separate document root and Indexes remains Inherit. The public index and missing Express route remain a confirmed operational failure; no sensitive file contents were examined. |
| API hostname | FAIL — exact cause unknown | HTTPS `/healthz` timed out after 10.007 s, HTTP `000`, zero bytes. cPanel logs show Passenger context markers for the API hostname but no error/timeout marker in the visible snapshot. Effective proxy/upstream/request handling remains unverified. |
| DNS/TLS | PASS (limited) | All three A records resolve to `122.173.84.249`; curl certificate validation succeeded. This does not identify the effective vhost or upstream. |
| Responding web server | PARTIAL | Public responses identify LiteSpeed. Effective virtual-host configuration is unavailable; an upstream Nginx layer is neither confirmed nor ruled out. |
| cPanel runtime | PARTIAL | Node.js `v20.20.2`, Passenger, startup `server/index.js`, application root `/home/shopadem/shopademia-app`, and `started` status are reported for the storefront URI. The live deployed SHA and actual request mapping remain unknown. |
| cPanel logs | PARTIAL / non-diagnostic | Visible Errors-page snapshot showed Passenger INFO/restart-marker entries for storefront/admin/API host contexts and no error-level/timeout strings. It does not establish request routing, process health for each hostname, or explain the API timeout. |
| PostgreSQL and recovery | BLOCKED | cPanel lists `shopadem_shopapp` (8.54 MB); the app's actual connection target remains unknown. No automatic backups are reported; partial Oct. 8 downloads were not restored. Backup integrity, uploads, isolated restore, rollback, and staging are unverified. |
| Source security review | PASS (bounded) | Focused source review found no vulnerabilities at `61eff3c`; live secrets, DB grants, deployed proxy configuration, and runtime behavior were not reviewed. Dependency audit separately reports 0 vulnerabilities. |
| Test/build | PASS (local scope) | `npm test`: 169 total, 168 passed, 0 failed, 1 opt-in PostgreSQL test skipped. CSS build passed and the generated artifact was synchronized with the command output. No real PostgreSQL integration, full browser flow, or production smoke test. |
| Other audit scope | OPEN | No Android project/manifest is present in this revision. Full browser customer/admin journeys, PostgreSQL restore/concurrency checks, and owner-approved privacy/fulfillment/refund decisions remain outstanding; see `AUDIT_REPORT.md`. |

### Prioritized release issues

1. **P1 HOST-001 — Admin listing and `/admin` 404:** suppress indexing using the supported cPanel control, then map the hostname to the existing Express app. Do not delete files.
2. **P1 HOST-002 — API hostname timeout:** provider must inspect effective LiteSpeed/Passenger/proxy configuration and request-timeout logs; map the allowlisted API paths and health route to the existing Express process.
3. **P1 OPS-001 — Recovery not proven:** identify the live PostgreSQL target privately; back up database and uploads; prove isolated restore and application/data rollback.
4. **P1 DEP-001 — Deployment target/live revision unknown:** verify deployed commit, effective environment, staging, persistent storage, and authorized rollback path.
5. **P2 AUD-001 — Product acceptance gaps:** complete isolated database and browser tests, recover owner-approved requirements/policies, and do not imply Android support for this source tree.

**Verdict remains `PRODUCTION NO-GO — DEPLOYMENT BLOCKED`.** No production configuration or data was changed.

## Production-release continuation — 2026-10-19 16:57 +06

This refresh rechecks the current published candidate and public service outcomes. HTTP reachability is not end-to-end product acceptance.

| Requirement | Status | Current evidence / limitation |
|---|---|---|
| GitHub branch, push, and CI | FIXED AND VERIFIED | Local HEAD, GitHub branch, and `git ls-remote` match `c50408de67163f5b727dc45639d3ad630b64c396`. CI run [39240110333](https://github.com/AbidHossainTushar003/LiveShopademia/actions/runs/39240110333) passed for this SHA. No production deployment is implied. |
| Storefront host | OPEN | HTTPS root 200 HTML (34,371 bytes, 0.381 s); `/healthz` 200 JSON `{"status":"ok"}`; same-origin catalog 200 JSON. No current browser customer journey, release identity, or database persistence verification. |
| Admin host | BLOCKED — PROVIDER | Root remains a 1,593-byte LiteSpeed index; `/admin` remains 404. Separate cPanel document root is confirmed; the previously observed setting is Indexes Inherit. No production setting was changed. |
| API host | BLOCKED — PROVIDER | `/healthz` still times out after 10.013 s with no response bytes; browser shows provider HTTP 500 Request Timeout. cPanel log snapshot is informational only and not request-correlated. |
| PostgreSQL identity and grants | BLOCKED — PROVIDER | cPanel lists a database/user, but effective app URL, target, schema, and permissions remain unverified. |
| Backup, restore, uploads, rollback | BLOCKED — RECOVERY | No verified full backup, isolated restore, uploads recovery check, or rollback rehearsal. |
| Staging/E2E/real PostgreSQL integration | BLOCKED — PROVIDER | Required `.env.staging` and `.env.production` are absent; config validators fail closed. E2E listing is blocked by missing `PLAYWRIGHT_BASE_URL`; production is disallowed by the target guard. The opt-in PostgreSQL integration test remains skipped. |
| Local unit/API suite | FIXED AND VERIFIED | `npm test`: 169 total, 168 passed, 0 failed, 1 skipped. Scope is automated local tests; no live or end-to-end acceptance. |
| CSS output | FIXED AND VERIFIED | `npm run build:css` output matches the checked-in artifact exactly. |
| Dependency audit | FIXED AND VERIFIED | `npm audit --audit-level=low`: zero advisories. |
| Source security / secret checks | OPEN | Source review at `61eff3c` reported no vulnerabilities in scope; no dedicated scanner or history scan. The local pattern scan found two test-only URL-credential validation fixtures, not emitted as secret values. Production configuration and database grants remain outside scope. |
| Android/client scope | OPEN | No Android Gradle project or manifest in current HEAD; reconcile with release scope before claiming cross-client acceptance. |
| Legal/business, monitoring, operations | OPEN | Earlier owner/legal decisions and monitoring requirements remain unresolved; no staging or live observability acceptance. |

Production remains NO-GO. Provider route diagnosis and recovery proof are release gates, not code-test gaps that can be waived by CI.

## Post-containment verification — 2026-10-19 17:09 +06

| Requirement | Status | Current evidence / remaining action |
|---|---|---|
| Admin directory-index containment | FIXED AND VERIFIED (containment only) | For the confirmed cPanel root `/home/shopadem/admin.shopademia.store`, prior setting was **Inherit**; cPanel saved **No Indexing** and confirmed directory indexing disabled. Reopened control shows No Indexing selected. Rollback is to select Inherit for this same root. Public `/` now returns LiteSpeed HTTP 403 (1,242 bytes); no directory-index marker was present. |
| Admin application and protected routes | BLOCKED — PROVIDER | Public `/admin` still returns LiteSpeed HTTP 404; the containment setting does not map the domain to Express. Provider-supported routing to the existing app and authenticated protected-route verification remain required. |
| Storefront host and same-origin API | OPEN | Fresh HTTPS probes: root 200 HTML (34,371 bytes); `/healthz` 200 JSON (15 bytes); `/api/v1/products` 200 JSON (3,770 bytes). No browser customer journey, deployed SHA, or persistence acceptance. |
| Dedicated API hostname | BLOCKED — PROVIDER | Fresh `/healthz` probe timed out at 10.008 s with HTTP `000` and zero bytes. Effective LiteSpeed/Passenger/upstream mapping and correlated logs are required. |
| PostgreSQL, backup/restore, rollback, staging | BLOCKED — RECOVERY / PROVIDER | Production connection identity, complete database/upload backup, successful isolated restore, rollback rehearsal, and isolated staging remain unverified. |
| Git and CI evidence at probe time | PASS (source/CI only) | At the time of the public/cPanel recheck, local `feature/admin-v2` was at `7c7895ac635f93882e8c46e67e737b0d953f35c4`; GitHub Actions run [39241513265](https://github.com/AbidHossainTushar003/LiveShopademia/actions/runs/39241513265) passed for that SHA. The configured local `github` remote points elsewhere and `git ls-remote` returned repository-not-found; this does not invalidate the repository Actions record or prove deployment. |

No application code, production files, DNS, process, database, uploads, orders, inventory, or customer records were changed. The cPanel setting is a narrowly scoped, reversible listing containment only. **PRODUCTION NO-GO — DEPLOYMENT BLOCKED** remains the verdict.

## Recovery and routing recheck — 2026-10-19 17:17–17:22 +06

| Gate | Status | New evidence / next action |
|---|---|---|
| Admin directory indexing | PASS — containment | cPanel still showed No Indexing for `/home/shopadem/admin.shopademia.store`; public root returned LiteSpeed 403, 1,242 bytes, with no directory-index marker. This is not admin availability. |
| Admin app route | FAIL — provider mapping | Public `/admin` returned LiteSpeed 404. Source registers Express `/admin` and `/admin/` redirect; effective virtual host/proxy mapping remains unavailable. |
| Storefront | PASS — reachability only | Root, `/healthz`, and same-origin `/api/v1/products?limit=1` returned HTTPS 200. |
| Dedicated API | FAIL — provider diagnosis | `/healthz` timed out at 10.014 seconds with HTTP `000`, zero bytes. All three A records resolve to `122.173.84.249`; this does not establish correct virtual hosts. |
| PostgreSQL identity | BLOCKED — ACCESS | cPanel lists `shopadem_shopapp` (8.54 MB) and `shopadem_shopuser`; no live application connection target or grants were verified. |
| Database backup and restore | BLOCKED — SAFETY | cPanel Backup has no automatic backups; its partial SQL download is `shopadem_shop.sql.gz`, not the listed PostgreSQL DB name. JetBackup Restore & Download → Full Backups lists four records, but its Databases category shows No Backups Found. No download/integrity/isolated-restore test was performed. |
| Upload inventory/recovery | PARTIAL / BLOCKED | File Manager metadata only confirms app-root `/uploads` with two image files (~252.77 KB total); contents were not opened. JetBackup Home Directory category shows No Backups Found; backup coverage and restored references remain unverified. |
| Rollback and staging | BLOCKED — SAFETY / ACCESS | No current release rollback rehearsal or isolated environment. `.env.staging`, `.env.production`, `TEST_DATABASE_URL`, and `PLAYWRIGHT_BASE_URL` are absent; validators and E2E listing fail closed. |
| Local tests/security/build | PASS — local scope | 169 tests: 168 passed, 0 failed, 1 opt-in PostgreSQL test skipped; npm audit zero vulnerabilities; CSS build passed without tracked output change; `git diff --check` passed. |
| Git and exact-SHA CI at evidence collection | PASS — source/CI only | Branch `feature/admin-v2` at `bfb7277de0de1fe4f7a772fdcdfd00799e935fd7`; intended GitHub branch matches; Actions run [39243091143](https://github.com/AbidHossainTushar003/LiveShopademia/actions/runs/39243091143) succeeded. This is not deployment evidence. |

**Next action:** provider to supply effective LiteSpeed/Passenger routing and request-correlated logs for the probe window, map both hostnames to the existing Express app through a supported change, and establish consistent protected PostgreSQL/upload backup plus isolated restore/rollback. No production mutation or deployment is approved by this verification. **PRODUCTION NO-GO — DEPLOYMENT BLOCKED.**

## Timestamped routing matrix and recovery gate — 2026-10-19 17:37–17:38 +06

| Host/path | DNS A | Latest observation | Conclusion / status |
|---|---|---|---|
| Storefront `/` | `122.173.84.249` | 17:37:33.460 +06; TLS verified; 200 HTML, 34,371 bytes, 0.368 s; LiteSpeed; no redirect | Reachability PASS only; customer flows/live SHA unknown |
| Storefront `/healthz` | `122.173.84.249` | 17:37:33.858 +06; TLS verified; 200 JSON, 15 bytes, 0.276 s; LiteSpeed | Health response PASS; effective proxy topology unknown |
| Storefront `/api/v1/products?limit=1` | `122.173.84.249` | 17:37:34.158 +06; TLS verified; 200 JSON, 3,770 bytes, 0.274 s; LiteSpeed | Same-origin API reachability PASS |
| Admin `/` | `122.173.84.249` | 17:37:34.455 +06; TLS verified; 403 HTML, 1,242 bytes, 0.270 s; LiteSpeed. 17:38:11.689 body check: no directory-index marker. | cPanel No Indexing remains selected; containment PASS, admin UI not proven |
| Admin `/admin` | `122.173.84.249` | 17:37:34.748 +06; TLS verified; 404 HTML, 1,251 bytes, 0.272 s; LiteSpeed | FAIL — intended vhost/app mapping unverified; no correlated logs |
| API `/healthz` | `122.173.84.249` | 17:37:35.053 +06; TLS negotiated/verified; timed out at 10.011 s, HTTP 000, zero bytes | FAIL — exact cause unknown; no correlated logs |

Requests followed redirects and each final URL matched the requested URL; no redirects were observed. No request IDs or provider logs were available. LiteSpeed response headers do not establish whether an upstream proxy exists.

| Recovery/staging gate | Status | Clearing evidence |
|---|---|---|
| Live PostgreSQL identity/role | BLOCKED — ACCESS | Provider confirms actual runtime target/grants privately |
| Complete PostgreSQL backup | BLOCKED — SAFETY | Supported consistent backup of verified DB; timestamp, checksum/integrity, version, schema/data coverage |
| Complete uploads backup | BLOCKED — SAFETY | Inventory of authoritative persistent paths, validated backup coverage and DB reference consistency |
| Isolated DB+uploads restore | BLOCKED — SAFETY | Separate named target, successful restore, integrity/data and file-reference checks |
| Application/data rollback | BLOCKED — SAFETY | Release identity, migration compatibility and isolated rollback rehearsal |
| Host routing / admin / API | BLOCKED — PROVIDER | Effective vhosts, Passenger listener/socket, correlated logs, supported mapping, successful public verification |
| Staging and E2E/PG integration | BLOCKED — ACCESS / SAFETY | Separate app, DB/role, secrets, uploads, controlled URL and side effects verified |
| Provider support request | BLOCKED | Request remains **PREPARED — NOT SENT**; no authenticated provider-ticket integration or provider response/ticket reference is available. Account owner must submit through the authenticated provider interface and preserve the checklist evidence. |

Exact-SHA CI run [39247003547](https://github.com/AbidHossainTushar003/LiveShopademia/actions/runs/39247003547) passed for `ae67305f08051e88b4fcfb2cd1b716df6a968636`; this does not clear production gates. **PRODUCTION NO-GO — DEPLOYMENT BLOCKED.**

### Fixture-backed storefront follow-up — 2026-10-19 21:23 +06

`tests/e2e/storefront.spec.js` passed 19/19 Chromium tests against a temporary loopback app and the isolated, marked test database at `127.0.0.1:55442`. Synthetic demo data was removed transactionally; final verification found zero seeded shop, product, category, or order rows. The temporary app on `127.0.0.1:3003` was stopped. Existing preview and isolated database services remain loopback-only. Privileged admin browser tests were not run because their guard rejects local targets. This is local validation, not staging or production evidence; all production routing, recovery, staging, and approval gates remain blocked.

### Isolation guard and provider handoff recheck — 2026-10-19 21:28 +06

Read-only connection checks confirmed the isolated preview DB at `127.0.0.1:55441` and integration DB at `127.0.0.1:55442`; current local services remain loopback-bound. A port-specific guard now prevents the PostgreSQL integration test from opening a connection to port `5432`, with a regression test. The focused suite passed 7/7, including the PostgreSQL integration case. The provider request remains **REQUEST PREPARED — NOT SENT**; no provider response was supplied, so external routing and hosting capabilities remain unverified.

### Preview-role least-privilege and full-suite recheck — 2026-10-19 21:32 +06

The preview role-level write check failed: the role's ordinary transaction default is read-write, it has database and schema creation privileges, owns 23 public tables, and can write those tables. The app's currently running pool forces read-only transactions and the HTTP allowlist still returns only safe reads, but this does not satisfy role-level least privilege. The hardened source verifier now refuses to certify/restart this DB role; current preview remains running without restart and is explicitly not considered privilege-verified. Owner/DB administrator action is required to provision a distinct restricted role and update the protected local preview config.

Latest `npm test` passed 170/170 with isolated PostgreSQL integration enabled. Local read-only endpoint checks: `/healthz`, product list/search, and categories returned 200; `/admin` returned the intentional preview 404. The configured role failed the hardened verifier as expected. The earlier fixture-backed storefront E2E remains 19/19; no E2E code changed. Production routing, backups, restore, rollback, staging, and authorization remain blocked.

### Restricted preview role remediation attempt — 2026-10-19 21:44 +06

No documented/protected PostgreSQL administrator config or `pgpass`/service credential was found, so role remediation and preview restart were correctly blocked. The already-running preview remains loopback-only but is **NOT APPROVED FOR CONTINUED USE** until its role is restricted. Integration URL preflight now checks exact DB/role/loopback port before pool creation and rejects remote hosts, port 5432, altered identity, query overrides, and fragments. Latest full tests passed 170/170; CSS build and audit passed. The prior fixture-backed storefront run was 19/19; no repeat was necessary because E2E code did not change. Production remains blocked.

### Preview administration access recheck — 2026-10-19 21:57 +06

The preview cluster requires SCRAM for local and loopback PostgreSQL connections. Only the protected application-role config exists; no authorized admin credential or configured service/pgpass mechanism was found. No authentication workaround was attempted. The preview role remediation and safe restart remain blocked, and the current preview process is not approved for continued use until a restricted role is provided and independently verified.

### Shared browser follow-up — 2026-10-19 17:54–17:56 +06

| Area | Latest evidence | Status |
|---|---|---|
| API `/healthz` | At 17:56:26.266 +06, shared browser showed HTTP 500 with a `Request Timeout` page. Earlier bounded curl returned HTTP 000 after 10 seconds. | FAIL — provider/upstream cause still unknown; obtain effective route and correlated logs. |
| cPanel runtime inspection | At 17:54:33.229 +06, the Tools page recorded a resource 401. Application Manager and Setup Node.js App links were visible, but opening Application Manager did not navigate away from Tools or reveal runtime/process details. | BLOCKED — ACCESS / EVIDENCE; menu links do not verify runtime capability. |

No production state was changed. The existing provider request should include the API 500 observation and timestamp; no provider ticket has been submitted.

### Local run readiness — updated 2026-10-19 21:03 +06

The documented local preview and a separately created integration database are running on loopback-only PostgreSQL 16.15 clusters (ports 55441 and 55442, respectively). The preview DB identity and schema checksums were verified; an earlier session-level read-only connection setting was mistakenly treated as proof of role-level isolation. A later direct inspection found the preview role is a database/schema-capable owner of public tables with write privileges, so local preview role isolation is now BLOCKED. The integration DB has separate database/role markers and a non-superuser role without database/role creation privileges. The unverified port 5432 target was not touched.

At that time, `npm test` passed all 169 tests with the PostgreSQL concurrent-oversell integration test enabled (0 failed, 0 skipped); synthetic product/order fixtures were absent after cleanup. `npm run test:e2e` against `http://127.0.0.1:3002` passed 16 of 19 Chromium tests, with 0 failures and 3 skips because the preview contains no product/shop fixtures. `/healthz` returned HTTP 200 `{"status":"ok"}`; catalog and category reads returned 200 with empty data; admin paths returned intentional read-only-preview 404 responses. `npm run build:css` passed with no generated tracked diff; fresh `npm audit --audit-level=low` reported zero vulnerabilities. Node.js `v24.21.0`, npm `11.19.0`.

This local evidence does not verify production routing, live PostgreSQL identity, complete backups, isolated production recovery/rollback, provider support, production staging, or release authorization. **PRODUCTION NO-GO — DEPLOYMENT BLOCKED.**

### Independent release verification — 2026-10-19 22:05 +06

GitHub Actions run `39247003547` passed on exact HEAD `ae67305f08051e88b4fcfb2cd1b716df6a968636`, including tests, CSS, dependency audit, Compose/Caddy validation, and image build. Fresh local `npm test` with the protected integration config passed **170/170**; CSS build passed; `npm audit --audit-level=low` reported **0 vulnerabilities**; and `git diff --check` passed. Read-only integration-target verification confirmed database/role markers at `127.0.0.1:55442` and zero remaining demo products, fixture orders, or fixture logs. Fixture-backed E2E remains 19/19 from its prior run; it was not repeated because the E2E and application behavior code did not change and the current preview process is not an approved target.

Production and staging validators fail closed because `.env.production` and `.env.staging` are absent. The shared cPanel Tools view exposes a Billing & Support → Open Ticket menu entry but reports a resource HTTP 401; the actual ticket form was not verified and the request remains **PREPARED — NOT SENT**. The preview role remains write-capable with no authorized admin path; no app restart, production/provider modification, backup, restore, rollback rehearsal, or staging run occurred. **PRODUCTION NO-GO — DEPLOYMENT BLOCKED.**

### Bounded public route recheck — 2026-10-19 22:06 +06

Read-only GETs to the storefront root, `/healthz`, and `/api/v1/products?limit=1` returned HTTP 200 from `122.173.84.249`; admin root returned 403, admin `/admin` returned 404, and API `/healthz` timed out after 10 seconds with HTTP 000 / curl exit 28. No response bodies were retained. These symptoms do not establish effective host mappings or cause; provider confirmation and correlated logs remain blocked. The current admin-root status differs from the historical directory-index response; the prepared request wording is retained, with these timestamped observations to be appended when the account owner submits it.

## Gate execution register — 2026-10-19 22:12 +06

This register identifies who owns each missing action, what evidence closes it, and how that evidence must be checked. “Local/CI pass” is never substituted for provider, staging, recovery, or production evidence. The latest bounded route probes and CI/test outcomes are recorded above; older observations elsewhere in this report are historical.

| Gate / current status | Evidence required to close | Verification method | Owner |
|---|---|---|---|
| Source and CI — PASS, limited to exact HEAD | Reviewed immutable release SHA and successful checks for that SHA | Compare GitHub branch/run SHA to local `git rev-parse HEAD`; inspect all required job conclusions | Engineer / account owner |
| Storefront/admin/API ownership and routing — BLOCKED | Provider-confirmed domain ownership, active vhost/document root, upstream/listener, TLS and route mappings for all three hosts; explanation of current status codes with correlated logs | Read provider configuration/log evidence; then bounded external GETs for expected storefront/admin/API routes and independent staging smoke tests | Hosting provider; account owner verifies |
| Admin listing containment — PARTIAL (historical cPanel evidence); routing BLOCKED | cPanel No Indexing was reported selected at 17:17–17:38 +06; later public root GET returned 403 at 22:06 +06. Not a fresh setting read; `/admin` still 404. | Freshly verify cPanel Indexes remains No Indexing; bounded GET confirms no listing; provider confirms effective admin vhost/upstream and logs | Account owner / provider |
| Supported production runtime — PARTIAL (apex Passenger only); routing/architecture BLOCKED | Historical cPanel reports one started Passenger app on apex `shopademia.store/`, Node 20.20.2, root `/home/shopadem/shopademia-app`, startup `server/index.js`; admin/API remain separate roots. Docker/Compose/Caddy and effective env/mappings unconfirmed. | Provider supplies effective runtime/vhost/upstream/config evidence; demonstrate supported same-app routing and isolated staging before any production change | Provider; account owner chooses |
| Live PostgreSQL identity and grants — BLOCKED | Protected confirmation of production DB identity/version, application/migration roles, effective grants and network path; no secret values | Provider-supplied protected evidence plus independent read-only connection/identity/grant checks by authorized DBA | Provider / authorized DBA |
| Production DB and upload backup — BLOCKED | Complete consistent backup scope for PostgreSQL and every persistent upload path, timestamp/timezone, versions, checksums, retention, secure retrieval and DB-to-file inventory | Verify tool exit statuses, archive/database integrity, checksums and reference coverage without writing to production | Provider / authorized DBA |
| Isolated restore and integrity — BLOCKED | Separate named restore target with independent credentials/storage; successful schema/data restore and upload restoration | Restore only into isolated target; compare schema/migration checksums, constraints, representative records, file checksums and DB file references | Authorized DBA / release engineer |
| Rollback rehearsal — BLOCKED | Prior app/config identity, compatible database recovery point, upload snapshot and owner-defined RPO/RTO | Rehearse rollback in isolated environment; record timings, versions, integrity checks and outcomes | Release engineer / authorized DBA |
| Isolated staging — BLOCKED | No private staging target or env file is verified; `.env.staging` is absent and validator fails closed. Repository staging Compose uses a distinct DB/app configuration and loopback-published Caddy, but this source configuration is not a provisioned host. | Provider/account owner demonstrates private network, separate app/DB/least-privilege credentials/uploads/secrets, synthetic data, and disabled real payments/notifications; then verify markers and run staging suites | Account owner / provider / release engineer |
| Product, category, search, pricing, cart, checkout and order workflows — LOCAL/CI PASS, STAGING BLOCKED | Passing DB-backed integration and product-backed browser flows on verified staging SHA; no live order/payment side effects | Run focused integration suite and Chromium E2E against staging; check synthetic data setup and cleanup counts | Release engineer; staging owner |
| Inventory concurrency and cleanup — LOCAL PASS, STAGING BLOCKED | Concurrency test passes on isolated staging target and leaves no synthetic orders/logs/products | Verify test target markers before writes, run focused test, query fixture counts after cleanup | Release engineer / staging DBA |
| Admin authorization and session revocation — SOURCE/CI ONLY | Staging-backed tests for role boundaries, MFA, session revocation and cross-shop access using synthetic accounts | Run privileged suite only with explicit staging target guard and one-time staging approval; inspect results and cleanup | Security/release engineer; staging owner |
| Upload validation/storage — SOURCE/CI ONLY | Staging upload tests for type/signature/size/path handling and persistence/restore references | Synthetic valid/invalid upload test cases; verify storage target and cleanup in isolated staging | Release engineer / staging owner |
| Migrations, errors and security controls — CI ONLY | Migration compatibility, dependency/security checks, safe errors/logging, TLS/session/security headers and monitoring/alert evidence | CI on immutable SHA plus isolated staging tests and provider/runtime configuration review | Release/security engineer; provider for operations |
| Local preview role isolation — BLOCKED; DBA access/config update absent | Owner-selected role is `shopademia_preview_ro`; authorized DBA provisions it without changing the existing `shopademia_browser_preview` owner, protected config references it, and the fail-closed verifier accepts exact identity, effective `public`-only search path, no executable public SECURITY DEFINER routines, and no excessive grants | Run the read-only package [PREVIEW-DBA-READ-ONLY-DIAGNOSTICS-2026-10-19.md](./PREVIEW-DBA-READ-ONLY-DIAGNOSTICS-2026-10-19.md) first; verify effective grants (including column grants and `PUBLIC`), memberships, database/schema/table/sequence/routine/type ownership, database/schema/TEMP creation, required reads and future-object defaults. Restart only after separate owner authorization | Account owner authorizes any database/config/process change; authorized local DBA diagnoses/provisions; code maintainer owns guard |
| Provider support response — NO TICKET EVIDENCE RECEIVED | Ticket number, timezone-qualified timestamp, exact submitted subject/body, full response/transcript, attachments/request IDs/log timestamps | Inspect the actual ticket and evidence; separate provider-confirmed statements from cPanel UI observations and public probes; redact secrets/customer data | Account owner supplies ticket evidence |
| Production approval and deployment — BLOCKED / NOT AUTHORIZED | All gates above evidenced, exact change/target/rollback identified, explicit owner authorization for that change | Independent release checklist sign-off immediately before change; verify public storefront/admin/API and DB-backed flows afterward; execute approved rollback on failure | Account owner authorizes; release engineer executes |

### Provider-ticket addendum prepared, not submitted

Keep the existing suggested subject and request body above unchanged. Append this correction because it is newer than the request's historical route description:

> **Fresh public observations (2026-10-19, approximately 22:06 +06; checks completed by 22:06:37 +06):** bounded HTTPS GETs to `shopademia.store/`, `/healthz`, and `/api/v1/products?limit=1` returned HTTP 200 from `122.173.84.249` (curl exits 0). `admin.shopademia.store/` returned HTTP 403 and `/admin` HTTP 404 (curl exits 0). `api.shopademia.store/healthz` returned no response bytes within 10 seconds (HTTP 000, curl exit 28) from the same address. The latest admin-root result is 403, not the older directory-index response described above. Please correlate these observations with the active vhost/upstream and request logs; do not infer a cause from status codes alone. No production state was changed.

No actual provider ticket response or ticket evidence has been received with the current user message. The shared cPanel Tools page visibly lists **Billing & Support → Open Ticket**, but reports a resource HTTP 401; the actual ticket form and authenticated account access were not verified. Requesting the response from the account owner is the next evidence intake step. The previously prepared status remains **PREPARED — NOT SENT** until a verifiable ticket record is provided.

Existing account-visible cPanel evidence (not a ticket response) records a started Passenger Node 20.20.2 app on the apex URI, separate admin/API roots, and a listed PostgreSQL database. It does not confirm the effective vhost, admin/API mappings, deployed SHA, runtime DB connection, or Docker/Compose/Caddy support. Smallest safe remediation is provider-supported mapping of admin/API routes to the existing Express app followed by independent route checks; no DNS change or second backend is justified.

### DBA privilege diagnostic addendum — 2026-10-19 22:43 +06

### Local DBA handoff — preview only, prepared and not executed

The owner/code-maintainer decision is now explicit: the dedicated runtime role name is `shopademia_preview_ro`, provisioned only by an authorized local DBA. The source verifier and database-free regression tests have been aligned to that name. The intended target remains the isolated database `shopademia_browser_preview` at `127.0.0.1:55441`. The existing `shopademia_browser_preview` role is the unsafe owner and must remain unchanged; do not rename it, transfer its objects, or reuse it for the app. No authorized DBA credential/service has been made available, so no SQL, protected-config change, role provisioning, or application restart is authorized or has occurred. Never guess credentials or contact port `5432`.

**Preflight and inventory (read-only, authorized DBA connection only):**

1. Connect through the approved local administration mechanism directly to `127.0.0.1:55441`; confirm `current_database() = 'shopademia_browser_preview'`, the expected server address/port, server version, and existing owner before any DDL. Stop if any identity differs. Record a protected pre-change inventory of `pg_database`, `pg_roles`, `pg_auth_members`, schema and object owners, database/schema/table/column/sequence ACLs, `PUBLIC` ACLs, defaults, and dependencies. Do not expose credentials in output.
2. Inspect the actual SQL used by the read-only route allowlist and verifier. Current source queries require `schema_migrations(version, checksum)`; `shops` fields used by storefront/profile/config/sitemap reads (`id`, `slug`, `name`, `status`, `advance_charge`, `description`, `location`, public contact fields and public image fields); `managed_products` fields loaded at startup (`id`, name/description/SEO, price fields, category, image fields, stock/availability/archive fields, `shop_id`, `created_at`); `shop_product_categories` (`shop_id`, `id`, name/description/icon/active); `shop_hero_slides` (`shop_id`, `id`, position, image fields, headline/body/button/target); and public `shop_offers` fields/filters/order fields (`shop_id`, id/title/message/image, start/end times, published flag, creation time). The top-selling page and API are excluded from the read-only preview because `SELECT` on `orders.items` would expose the complete JSON value, not only the product ID and quantity keys used by the aggregate. The verifier checks required order-column presence through PostgreSQL catalogs only; it does not require `SELECT` on order data. If top-selling is needed in a future preview, first design and separately authorize a database-side aggregate view or equivalent. Review source again before provisioning because these dependencies can change. Grant only the required columns where practical; do not infer the list from schema presence. `admin_settings` is deliberately not needed in preview: preview announcement returns its static default and has a regression test proving it makes no database query. Admin, customer/order lookup and mutation endpoints remain excluded. Catalog metadata is inspected through PostgreSQL catalogs, including `pg_attribute`, so restricted column grants do not hide required-schema checks. Grant no sequence privilege unless a verified approved read query requires it (then `SELECT` only; never `USAGE` or `UPDATE`).
3. Check all effective privileges, including column-level grants, `PUBLIC`, and role memberships. The verifier's `has_database_privilege(current_user, current_database(), 'TEMP')` reports whether the connected role can create temporary objects by any effective grant path; it is separate from `CREATE` on the database and `CREATE` on `public`, both of which the verifier checks independently. `TEMP` is a database ACL privilege, commonly granted to `PUBLIC` by PostgreSQL defaults. A direct `REVOKE TEMP ... FROM shopademia_preview_ro` cannot cancel a grant to `PUBLIC`; `NOINHERIT` affects role-membership inheritance, not privileges granted to `PUBLIC`. A membership may also provide inherited privileges or `SET ROLE` capability, which is why the guard independently requires `NOINHERIT` and zero direct memberships. Do not revoke `PUBLIC` or alter any database without separate explicit authorization and confirmation of this exact isolated target. A targeted revoke on this one database would affect every role relying on `PUBLIC` TEMP there, so first inventory dependencies and obtain owner approval; if its impact is not acceptable, leave the guard failing and report the blocker rather than weakening it.

**Read-only diagnostic SQL (authorized DBA only; no credentials in output):**

Run these statements only after connecting through the approved local administration mechanism to the intended loopback endpoint. Every statement below is a `SELECT`; they do not provision roles or alter data. Query 1 must report database `shopademia_browser_preview`, server address `127.0.0.1`, and port `55441`; otherwise stop. Run it once on the authorized DBA connection for endpoint identity and again on a fresh `shopademia_preview_ro` connection after that role exists. The DBA connection's own effective grants are not evidence of the runtime role's grants. Queries using `current_user` report the role of the connection that executes them. Never run these diagnostics against port `5432`.

```sql
-- 1. Confirm the actual connection, role attributes, and effective database privileges.
SELECT current_database() AS database_name,
       current_user AS role_name,
       inet_server_addr() AS server_address,
       inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       current_setting('default_transaction_read_only') AS transaction_read_only,
       current_setting('search_path') AS configured_search_path,
       current_schemas(false) AS effective_nonimplicit_schemas,
       role.rolsuper, role.rolinherit, role.rolcreatedb, role.rolcreaterole,
       role.rolreplication, role.rolbypassrls,
       pg_get_userbyid(db.datdba) AS database_owner,
       has_database_privilege(current_user, db.oid, 'CONNECT') AS can_connect,
       has_database_privilege(current_user, db.oid, 'CREATE') AS can_create_in_database,
       has_database_privilege(current_user, db.oid, 'TEMP') AS can_create_temp_objects
FROM pg_database AS db
JOIN pg_roles AS role ON role.rolname = current_user
WHERE db.datname = current_database();

-- 1b. Candidate role attributes and effective database privileges, including
-- before role creation (the target-role fields then return NULL).
SELECT db.datname,
       candidate.rolname,
       candidate.rolsuper,
       candidate.rolinherit,
       candidate.rolcreatedb,
       candidate.rolcreaterole,
       candidate.rolreplication,
       candidate.rolbypassrls,
       pg_get_userbyid(db.datdba) AS database_owner,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_database_privilege(candidate.oid, db.oid, 'CONNECT') END AS can_connect,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_database_privilege(candidate.oid, db.oid, 'CREATE') END AS can_create_in_database,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_database_privilege(candidate.oid, db.oid, 'TEMP') END AS can_create_temp_objects
FROM pg_database AS db
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
WHERE db.datname = 'shopademia_browser_preview';

-- 1c. Stored role/database overrides relevant to the runtime's search path
-- and read-only default; deliberately omit all other setting values.
SELECT role.rolname,
       CASE WHEN settings.setdatabase = 0 THEN '(all databases)'
            ELSE db.datname END AS database_scope,
       setting.value AS setting
FROM pg_db_role_setting AS settings
JOIN pg_roles AS role ON role.oid = settings.setrole
LEFT JOIN pg_database AS db ON db.oid = settings.setdatabase
CROSS JOIN LATERAL unnest(settings.setconfig) AS setting(value)
WHERE role.rolname = 'shopademia_preview_ro'
  AND (settings.setdatabase = 0 OR db.datname = 'shopademia_browser_preview')
  AND (setting.value LIKE 'search_path=%'
       OR setting.value LIKE 'default_transaction_read_only=%')
ORDER BY database_scope, setting.value;

-- 2a. Direct membership edges for the candidate runtime role, including options.
WITH runtime AS (
    SELECT oid FROM pg_roles WHERE rolname = 'shopademia_preview_ro'
)
SELECT member.rolname AS member_role,
       granted.rolname AS granted_role,
       grantor.rolname AS grantor_role,
       membership.admin_option,
       membership.inherit_option,
       membership.set_option
FROM pg_auth_members AS membership
JOIN pg_roles AS member ON member.oid = membership.member
JOIN pg_roles AS granted ON granted.oid = membership.roleid
JOIN pg_roles AS grantor ON grantor.oid = membership.grantor
JOIN runtime ON runtime.oid = membership.member
ORDER BY granted.rolname;

-- 2b. Direct and transitive roles available to the candidate; USAGE means
-- their privileges are inherited without SET ROLE, MEMBER reports membership.
WITH runtime AS (
    SELECT oid FROM pg_roles WHERE rolname = 'shopademia_preview_ro'
)
SELECT candidate.rolname,
       pg_has_role(runtime.oid, candidate.oid, 'MEMBER') AS is_member,
       pg_has_role(runtime.oid, candidate.oid, 'USAGE') AS privileges_inherited
FROM runtime
CROSS JOIN pg_roles AS candidate
WHERE candidate.oid <> runtime.oid
  AND pg_has_role(runtime.oid, candidate.oid, 'MEMBER')
ORDER BY candidate.rolname;

-- 3. Database ACL entries, explicitly distinguishing PUBLIC from role grants.
SELECT db.datname,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable,
       has_database_privilege(current_user, db.oid, acl.privilege_type) AS effective_for_connection,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_database_privilege(candidate.oid, db.oid, acl.privilege_type)
       END AS effective_for_candidate
FROM pg_database AS db
CROSS JOIN LATERAL aclexplode(
    COALESCE(db.datacl, acldefault('d', db.datdba))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
WHERE db.datname = current_database()
ORDER BY grantee, acl.privilege_type;

-- 4. Non-system schema ownership, ACL entries, and effective USAGE/CREATE.
SELECT namespace.nspname,
       pg_get_userbyid(namespace.nspowner) AS schema_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable,
       has_schema_privilege(current_user, namespace.oid, 'USAGE') AS effective_usage,
       has_schema_privilege(current_user, namespace.oid, 'CREATE') AS effective_create
FROM pg_namespace AS namespace
CROSS JOIN LATERAL aclexplode(
    COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
ORDER BY namespace.nspname, grantee, acl.privilege_type;

-- 5. Public relation owners, effective relation privileges, and ACL entries.
SELECT namespace.nspname,
       relation.relname,
       relation.relkind,
       pg_get_userbyid(relation.relowner) AS object_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable,
       has_table_privilege(current_user, relation.oid, acl.privilege_type) AS effective_for_connection
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(
    COALESCE(
        relation.relacl,
        acldefault(CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END, relation.relowner)
    )
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY relation.relname, grantee, acl.privilege_type;

-- 5b. Sequence ACLs and effective SELECT/USAGE/UPDATE.
SELECT namespace.nspname,
       sequence.relname,
       pg_get_userbyid(sequence.relowner) AS sequence_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable,
       has_sequence_privilege(current_user, sequence.oid, acl.privilege_type)
           AS effective_for_connection
FROM pg_class AS sequence
JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
CROSS JOIN LATERAL aclexplode(
    COALESCE(sequence.relacl, acldefault('S', sequence.relowner))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE namespace.nspname = 'public'
  AND sequence.relkind = 'S'
ORDER BY sequence.relname, grantee, acl.privilege_type;

-- 6. Explicit column ACL entries and effective column-level privileges.
SELECT relation.relname,
       attribute.attname,
       pg_get_userbyid(relation.relowner) AS relation_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable,
       has_column_privilege(current_user, relation.oid, attribute.attnum, acl.privilege_type)
           AS effective_for_connection
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND attribute.attacl IS NOT NULL
ORDER BY relation.relname, attribute.attname, grantee, acl.privilege_type;

-- 7. Effective column privileges, including privileges inherited from PUBLIC
-- or role memberships even when no direct column ACL is present.
SELECT relation.relname,
       attribute.attname,
       privilege.privilege_type,
       has_column_privilege(
           current_user, relation.oid, attribute.attnum, privilege.privilege_type
       ) AS effective_for_connection
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))
    AS privilege(privilege_type)
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND has_column_privilege(
      current_user, relation.oid, attribute.attnum, privilege.privilege_type
  )
ORDER BY relation.relname, attribute.attname, privilege.privilege_type;

-- 8. Public routine ownership, SECURITY DEFINER status, ACLs, and effective EXECUTE.
SELECT routine.oid::regprocedure AS routine_name,
       pg_get_userbyid(routine.proowner) AS routine_owner,
       routine.prosecdef AS security_definer,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable,
       has_function_privilege(current_user, routine.oid, 'EXECUTE') AS effective_execute
FROM pg_proc AS routine
JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
CROSS JOIN LATERAL aclexplode(
    COALESCE(routine.proacl, acldefault('f', routine.proowner))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE namespace.nspname = 'public'
ORDER BY routine_name, grantee;

-- 9. Future-object default ACLs, by the role that will create each object.
-- These do not describe or change privileges on objects that already exist.
SELECT pg_get_userbyid(default_acl.defaclrole) AS object_creator_role,
       namespace.nspname AS schema_name,
       default_acl.defaclobjtype AS object_type_code,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable
FROM pg_default_acl AS default_acl
LEFT JOIN pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE default_acl.defaclnamespace = 0
   OR namespace.nspname = 'public'
ORDER BY object_creator_role, schema_name, object_type_code, grantee, acl.privilege_type;

-- 10. Public table/view/sequence/type/routine ownership inventory.
SELECT 'relation' AS object_kind,
       format('%I.%I', namespace.nspname, relation.relname) AS object_name,
       relation.relkind::text AS object_type,
       pg_get_userbyid(relation.relowner) AS owner
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
UNION ALL
SELECT 'routine', routine.oid::regprocedure::text, 'routine',
       pg_get_userbyid(routine.proowner)
FROM pg_proc AS routine
JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
WHERE namespace.nspname = 'public'
UNION ALL
SELECT 'type', format('%I.%I', namespace.nspname, object_type.typname), 'type',
       pg_get_userbyid(object_type.typowner)
FROM pg_type AS object_type
JOIN pg_namespace AS namespace ON namespace.oid = object_type.typnamespace
WHERE namespace.nspname = 'public'
ORDER BY object_kind, object_name;
```

Interpretation: Query 1's effective `can_create_temp_objects` must be false for the connected runtime role. Query 3 shows whether that comes from a direct role ACL or `PUBLIC` (`grantee = 'PUBLIC'`); queries 2a/2b independently expose direct and transitive memberships. `NOINHERIT` does not negate `PUBLIC` ACLs and does not erase membership/`SET ROLE` capability. A database-level `TEMP` grant creates objects in the session's temporary schema, not in `public`, so schema `CREATE` checks do not detect it. The read-only transaction default is defense in depth, not proof that the database ACL lacks TEMP. The current guard fails closed on the effective TEMP result even when every table write check is false.

The diagnostics must be reviewed as a complete set: effective table/column privilege functions include grants via `PUBLIC` and inherited roles; raw ACL rows identify grantors and whether `PUBLIC` received a grant; ownership is separate from ACL grants. The guard independently checks database/schema/table/sequence ownership, relation/column write privileges, creation rights, role attributes/memberships, and effective sequence privileges. The guard now also requires `current_schemas(false) = ['public']`; PostgreSQL's implicitly searched `pg_catalog` is excluded by `false`. The DBA's `current_schemas(false)` is not the candidate role's effective path. Inspect stored role/database overrides, then require the independently launched guard to report `['public']` on a fresh runtime-role connection before approval.

The database does **not** enforce a fixed SQL-statement allowlist for a login role: the application enforces its HTTP GET/HEAD route allowlist and executes its reviewed SQL, while narrow column-level `SELECT` grants bound data available to the trusted application. The connected role could issue other `SELECT` statements over any granted columns. Review public `SECURITY DEFINER` routines and effective `EXECUTE` grants. The guard now rejects any executable public `SECURITY DEFINER` routine; the app's reviewed SQL uses PostgreSQL built-ins, not custom `public` routines. Review views/materialized views in query 5 for definitions, owners, options, and underlying data exposure before granting SELECT; their SELECT ACL alone does not establish that they expose only approved data. Do not rely on these source observations if application SQL changes.

PostgreSQL 16 references for the authorized DBA: [object privileges and PUBLIC defaults](https://www.postgresql.org/docs/16/ddl-priv.html), [role membership inheritance and SET ROLE](https://www.postgresql.org/docs/16/role-membership.html), and [default privileges](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html).

**TEMP remediation decision path — planning only, no SQL authorized or run:**

1. Use the ACL rows and membership inventory to identify the source. If TEMP is granted directly to `shopademia_preview_ro`, a role-specific revoke can remove that direct grant but cannot remove another source. If it arrives through a membership, remove that membership only after confirming the relationship is not needed elsewhere; the preview role must have no memberships regardless.
2. If TEMP is granted to `PUBLIC`, there is no per-role deny/override for `shopademia_preview_ro`. `NOINHERIT`, a role-level default setting, and `REVOKE TEMP ... FROM shopademia_preview_ro` do not cancel the PUBLIC grant. The only in-place ACL remedy is a database-specific `REVOKE TEMPORARY ON DATABASE shopademia_browser_preview FROM PUBLIC`; this changes access for every role on this database that relies on PUBLIC TEMP. It requires (a) separate explicit owner authorization, (b) a fresh confirmation that the connection is to the marked isolated database at `127.0.0.1:55441`, and (c) impact review of all database users and workloads. Do not execute this or any revoke based only on this handoff.
3. If that shared effect is unacceptable or uncertain, leave the guard blocked and ask the owner to authorize a separately isolated preview database with an ACL policy that does not grant TEMP to PUBLIC; this would require separately reviewing and authorizing any matching verifier/target changes. Do not silently broaden the role or waive the verifier.
4. After any separately authorized change, re-run the read-only diagnostics as a fresh `shopademia_preview_ro` connection and require `can_create_temp_objects = false`, no memberships, no database/schema CREATE, and no excessive object privileges before touching protected app config. No application restart is included in this remediation authorization.

**Provisioning procedure (template only; do not run without separate owner authorization):**

1. Create `shopademia_preview_ro` as `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`. Set its secret interactively with the approved secret manager or `psql \password`; never put credentials in SQL history, command arguments, repository files, transcripts, or reports. Do not grant memberships or ownership.
2. Grant only `CONNECT` on the verified database and `USAGE` on `public`, plus `SELECT` on the individually reviewed tables needed by approved read queries. Do not grant `CREATE`, table/column `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`, sequence `USAGE`/`UPDATE`, or ownership. Preserve the existing owner, users, and object ownership.
3. Review default privileges for the **actual** migration/object creator role(s), not the runtime role. Default ACLs apply only to objects created subsequently by the role named in `ALTER DEFAULT PRIVILEGES`; they are not retroactive and are not inherited from roles whose privileges the creator can assume. The creating role must configure its own defaults (a DBA may act `FOR ROLE` only with appropriate authority); inspect each actual creator shown by query 9. Do not blindly grant `SELECT ON TABLES` across `public`: that would expose every future table, including potentially sensitive data. If every future table created by a specific owner in this schema is explicitly approved for preview reads, use a schema-scoped `ALTER DEFAULT PRIVILEGES FOR ROLE <actual_creator> IN SCHEMA public GRANT SELECT ON TABLES TO shopademia_preview_ro`; otherwise add explicit grants for reviewed new objects in the migration process and test them. `ON TABLES` includes tables and views and is table-wide, not a future column-level allowlist; future sensitive tables such as orders need explicit review rather than a blanket grant. Review default ACLs for tables/views, sequences, functions/routines, and types. PostgreSQL normally grants `EXECUTE` on newly created functions/routines to `PUBLIC`; the application currently calls no custom `public` routine, so inspect query 8 and review any public `SECURITY DEFINER` routine before approval. Removing that default requires review of the global default for each actual creator; schema-specific default REVOKE cannot subtract a global default grant. Existing table/view/sequence/column/routine grants must be audited separately; changing a default ACL does not repair existing objects. Also note schema-specific default ACL entries add to global defaults; they do not subtract global defaults. For sequences, default `SELECT` only if an inspected approved query needs it; never default-grant sequence `USAGE`/`UPDATE`. No default privilege SQL is authorized in this handoff.
4. Set defense in depth with `ALTER ROLE shopademia_preview_ro IN DATABASE shopademia_browser_preview SET default_transaction_read_only = on`. This does not replace privilege/ownership checks.

**Independent verification before configuration or restart:**

1. Open a fresh connection using the new role through the protected mechanism. Verify exact database, `127.0.0.1`, port `55441`, `current_user`, `rolsuper`, `rolcreatedb`, `rolcreaterole`, `rolinherit`, `rolreplication`, `rolbypassrls`, all memberships, database/schema `CREATE` and database `TEMP`, plus database/schema/table/column/sequence/routine/type ownership.
2. Verify effective table and column write/DDL privileges (including `PUBLIC`), sequence `USAGE`/`UPDATE`, and the required default transaction mode. Run only the verifier's approved `SELECT` checks and the allowlisted storefront reads.
3. In a disposable isolated test database/object, prove `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, `ALTER`, and ownership changes are denied to the runtime role while approved `SELECT` succeeds. Roll back every test transaction and verify the fixture is absent. Do not probe using production or the integration-test role.
4. Update the protected local preview configuration through its existing secure mechanism without displaying the secret. Run the independent fail-closed verifier and read-only preview tests with a fresh connection. Restart the preview only after the DBA verification passes and a separate explicit owner authorization is recorded; then verify loopback-only binding, approved GETs, intentional admin 404, no writes, and no secret exposure.

This is a handoff checklist, not evidence of provisioning. No role, password, grant, config, cluster, or process was changed. The currently running preview app remains **NOT APPROVED FOR CONTINUED USE**.

### Backup/restore script limitations

The repository scripts were inspected, not run. `scripts/backup-production.sh` defaults to `.env.production` and `docker-compose.production.yml`; it encrypts database/uploads outputs but does not emit a checksum manifest, prove a jointly consistent DB+uploads point, inventory DB-to-file references, or verify a restore. `scripts/restore-production.sh` defaults to that production Compose project and creates another database in its database service; this is not an independently isolated restore host. It does not verify DB-to-upload references or rehearse rollback. No backup/restore evidence exists from these scripts. Provider/account owner must supply a separately isolated target and supported complete backup method; validation must include timestamps, versions, checksums, archive/database integrity, schema/data, uploads, DB-file references, and an isolated rollback rehearsal.

No actual provider ticket response has been supplied. The account-visible cPanel evidence is not a provider ticket response and does not establish Docker/Compose/Caddy support or effective production routing. **PRODUCTION NO-GO — DEPLOYMENT BLOCKED.**

### Latest cPanel Terminal findings — 2026-10-20 08:44 +06

- Authorized read-only cPanel Terminal is available despite the separate configured SSH connection being rejected. It confirms the app root contains `package.json` and `server/index.js`, and the provisioned Node 20 environment matches the cPanel Node.js app registration. System `node`/`npm` are not on the account shell's default `PATH`.
- The admin document root has `Options -Indexes` and no top-level index file, explaining a 403 if requests are served from that static root. It has no filtered Passenger routing directives; effective vhost mapping is not provider-confirmed.
- The API `.htaccess` has duplicate Passenger declarations referencing two nonexistent roots, nonexistent Node 22 executables, and `server.js`, rather than the registered app root, Node 20 runtime, and `server/index.js`. This is a confirmed mismatch and probable timeout cause, but active handler/request correlation and safe supported shared-process routing remain unverified.
- Sanitized archived access-log summaries only cover older requests: admin `/` returned 200 through Oct 16; API `/` returned 500/404 on Oct 10 and 200 on Oct 13–16. They do not correlate to the Oct 20 failures. No raw/error logs or secret-bearing configuration was opened.
- No production file, route, restart, environment value, database, or secret was changed. Provider confirmation and a rollback-capable routing procedure remain required before repair. JWT rotation, production PostgreSQL identity/grants, staging, uploads persistence, backups/isolated restore, and release approval remain blocked. **PRODUCTION NO-GO — NOT DEPLOYED.**

### Staging preflight guard and publication check — 2026-10-20 08:52 +06

- **Staging endpoint guard:** A review found that `scripts/staging-preflight.js` accepted PostgreSQL URL query parameters, even though `pg-connection-string` can use `?host=` to override the apparent hostname. The preflight now rejects any query string or fragment. Regression coverage in `scripts/deployment-package.test.js` checks both forms without echoing supplied targets. Related targeted suite: 8 passed, 0 failed, 0 skipped. No full suite or audit rerun was required for this isolated check.
- **Artifact:** new package `release-artifacts/shopademia-cpanel-155b1c035e4857a5`, 79 manifest entries, SHA-256 `155b1c035e4857a52da8670193dac185fe7541ebac3af1b82da37a1006799940`, integrity verified. The former 79-entry artifact and checksum `6bfbfa3265939ada7b394b7e9626a71da1b8ae060420fb0166caaeb6dba9d80c` remain intact and verified.
- **Current public recheck:** 2026-10-20 08:52 +06: storefront `/healthz` 200, admin `/` 403, admin `/admin` 404, API `/healthz` and `/api/v1/healthz` timed out as HTTP 000. No host change or deployment followed.
- **GitHub target:** user-directed target `MyTestProjects007/TestingWeb`, branch `feature/admin-v2`, remote `2` resolves to tip `798e7227e907edbbd262e8fe25b78d9e79cd7247`, which is an ancestor of current local HEAD `ae67305f08051e88b4fcfb2cd1b716df6a968636`. No commit or push had occurred at the time of this check. The anomalous untracked root entries named `ktop Installer.exe…` and `tatus --short` are excluded from release staging.
- **Release remains blocked:** provider-supported routing/recovery, protected JWT rotation, production PostgreSQL identity/grants, isolated staging, durable uploads, backup/restore, and owner approval are unverified. **PRODUCTION NO-GO — NOT DEPLOYED.**

### GitHub publication and CI — 2026-10-20 09:00 +06

- Reviewed release files were committed as `c02daad391458ce691243e4352c005acca161097` and pushed by normal fast-forward to `MyTestProjects007/TestingWeb`, branch `feature/admin-v2`. `git ls-remote` confirmed the remote ref at this commit.
- GitHub Actions run [39361942295](https://github.com/MyTestProjects007/TestingWeb/actions/runs/39361942295) completed successfully, including tests, CSS build, dependency audit, Compose/Caddy validation, and production image build. The audit reported 0 vulnerabilities. The separate local targeted preflight test result is 8/8, 0 failed, 0 skipped.
- No production upload, restart, or route change occurred. Storefront health remains 200; admin `/` 403 and `/admin` 404; API health HTTP 000 timeouts at the latest bounded probe. Remaining security, database identity, staging, persistence, recovery, and provider routing gates keep production **NO-GO**.
