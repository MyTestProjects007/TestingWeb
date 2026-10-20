# Shopademia storefront and admin

Shopademia includes a responsive storefront, a Node.js/Express API, PostgreSQL-backed order storage, and a password-protected admin orders dashboard.

## Run locally

Requirements: Node.js 20 or newer and Docker Desktop for the included local PostgreSQL service, or an existing PostgreSQL server.

1. Copy `.env.example` to `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```
2. In `.env`, set a unique admin email, an admin password of at least 12 characters, and a random JWT secret of at least 32 characters. Generate a secret with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   `.env` is ignored by Git. Never share or commit it.
3. Start PostgreSQL:

   ```powershell
   docker compose up -d database
   ```

   If you use another PostgreSQL instance, change `DATABASE_URL` in `.env`.
4. Install dependencies and start the app:

   ```powershell
   npm install
   npm.cmd start
   ```

5. Open <http://localhost:3000> for the storefront and <http://localhost:3000/admin> for the admin dashboard. Keep the server running while using the site. Do not open `index.html` directly or use VS Code Live Server: the storefront and admin dashboard require the API served by this app.

### Isolated read-only browser preview on this host

The recovered local preview is a separate PostgreSQL 16 cluster and must not use the repository `.env` or the normal `npm.cmd start` development path, which initializes the database. After PostgreSQL is running on the verified loopback-only `127.0.0.1:55441`, launch the preview in PowerShell with its separately ACL-protected configuration:

```powershell
$env:DOTENV_CONFIG_PATH = "$env:LOCALAPPDATA\Shopademia\preview-recovery\shopademia.env"
$env:DOTENV_CONFIG_OVERRIDE = 'true'
$env:SHOPADEMIA_READ_ONLY_PREVIEW = '1'
node server/index.js
```

This mode verifies the database identity and schema using read-only queries, sets PostgreSQL connections read-only, skips initialization and migrations, and binds the app only to `127.0.0.1:3002`. The configured PostgreSQL role must be a non-owner with no role memberships, database/schema creation rights, or write privileges on public tables/sequences; the startup verifier rejects roles that fail these checks. A read-only connection setting alone is not a substitute for least-privilege database grants. It serves only the allowlisted storefront pages, public catalog/configuration reads, and approved static assets. All non-GET/HEAD methods are rejected before route handlers; only explicitly allowlisted GET/HEAD routes continue. Admin pages and every admin API route, notification endpoints (including push-key reads), the order-lookup page and submissions, checkout, and unknown or malformed paths are unavailable. Disallowed GET/HEAD paths fail closed with a generic 404; disallowed methods return 405 with `Allow: GET, HEAD`. Rejected routes do not execute their business handlers or issue database queries. Malformed, traversal-shaped, and unavailable static paths return a generic 404 without exposing filesystem details; supported assets remain confined to their public directories. A visible notice identifies the preview. This is for local browsing only, not a writable test environment or public deployment. Keep the protected config private and do not copy its secrets into `.env`, source, shell history, or command output.

The storefront includes `/privacy` and `/terms`, a consent choice for optional analytics, a social sharing image, and a generated `/sitemap.xml` and `/robots.txt`. Cart and wishlist remain in local browser storage; optional analytics trackers are not loaded unless a visitor allows analytics. Analytics integrations remain disabled until public tracker IDs are configured in `js/config/tracking.config.js`. The published policy text is an operational template and should be reviewed against the operator’s actual practices and local legal requirements.

Production uses separate `shopademia.store`, `admin.shopademia.store`, and `api.shopademia.store` hostnames. The Docker deployment supplies the storefront and admin origins explicitly; Caddy terminates TLS, redirects HTTP to HTTPS, and restricts each hostname to its intended routes. Keep application secrets in the server environment only. Browser-side image uploads are resized/compressed to WebP when the browser can produce a smaller file; the server still validates image type/signature and enforces upload limits.

The server creates the order tables, admin credential table, and indexes at startup. The PostgreSQL Docker volume persists when the app restarts. Back up the database and product-image volumes for disaster recovery. `npm run build:css` regenerates the checked-in production stylesheet when frontend styles change.

Build the production deployment bundle with `npm run package:deployment`. It contains the production/staging Compose files, Caddy configuration, Docker build inputs, database initialization files, and application runtime files; the generated manifest verifies every included file. It excludes environment files, credentials, uploads, `.git`, and `node_modules`. Building the bundle does not deploy or restart the service.

### Browser tests

For the local read-only preview, set `PLAYWRIGHT_BASE_URL` to its loopback URL and run `npm run test:e2e`; this runs only public storefront browsing checks in Chromium. `npm run test:e2e:all` includes admin UI scenarios and all configured browser engines. Admin specs fail during discovery unless `PLAYWRIGHT_ALLOW_PRIVILEGED_E2E=1` is explicitly set and the target guard validates a non-loopback HTTPS staging hostname, exact `PLAYWRIGHT_STAGING_HOST`, staging environment, and external per-run artifact paths. Use it only against an independently approved disposable staging target with synthetic accounts; it requires the matching Playwright browsers. The target guard rejects the production hostname. Do not run privileged or full suites against the read-only preview or any production service.

## Catalog and API

The storefront uses this application's same-origin API; it does not fetch catalog or checkout data from a third-party demo API. The product endpoints (`GET /api/v1/products`, `/api/v1/products?featured=true`, `/api/v1/products?sort=newest`, `/api/v1/products/hero-offer`, and `/api/v1/categories`) serve products published through the admin API. New installations start with no bundled sample listings. For local development only, an operator can explicitly run `node scripts/seed-demo-catalog.js --apply` to add 18 clearly labeled demo shops with 32 complete example products each. The seed refuses production, remote, SSL, and read-only-preview database targets; demo listings use public Unsplash image links and have no administrator accounts. Do not run it against real seller data. Product additions, edits, stock, availability, and images are managed through authenticated `/api/v1/admin/products` endpoints and persisted in PostgreSQL. Product details are required; sellers can combine up to 10 uploaded JPEG, PNG, or WebP images with public HTTPS image links. Checkout uses the server-owned catalog prices; the browser cannot set order prices.

The observed endpoint inventory, native bearer-session usage, request/response shapes, authorization requirements, Android base URLs, and remaining implementation gaps are documented in [docs/ANDROID_ADMIN_API.md](./docs/ANDROID_ADMIN_API.md).

### Shop product API for external websites

Every active shop has a public, read-only JSON endpoint containing only products published for that shop, never products from other shops:

```text
GET https://YOUR_DOMAIN/api/v1/public/shops/SHOP_SLUG/products
```

The Shop Management dashboard shows the selected shop's exact URL and a copyable integration example. The endpoint is unauthenticated by design so external websites can use it, allows cross-origin `GET` requests, and must not contain customer or order information. It is rate-limited and responses may be cached for up to 30 seconds. Suspended or unknown shops return 404.

Optional query parameters are `limit` (1–100, default 50), `offset` (non-negative integer, default 0), and `category` (a built-in category ID or one created for that shop). Responses include `shop`, `data`, and `pagination`; product entries include ID, name, description, price, old price, absolute image URL, category, stock quantity, and availability. Example:

```js
const url = 'https://YOUR_DOMAIN/api/v1/public/shops/SHOP_SLUG/products?limit=50';
const response = await fetch(url);
if (!response.ok) throw new Error('Could not load shop products');
const { shop, data: products, pagination } = await response.json();
```

To show subsequent pages, request the same endpoint with `offset` increased by `pagination.limit` while `pagination.hasMore` is true.

### Admin account inventory (keep passwords private)

There are no universal or hard-coded demo passwords. Use this inventory to identify the accounts for your deployment; record the actual email addresses and passwords only in a private password manager, not in this repository, a README, or a public issue.

| Account | Username / email source | Password source |
| --- | --- | --- |
| Main platform administrator | `ADMIN_EMAIL` in the private server environment | `ADMIN_PASSWORD` in the private server environment |
| Shop administrator 1 | Email assigned when the platform admin adds the shop member | Temporary password set during account creation; share securely and change after first sign-in |
| Shop administrator 2 | Email assigned when the platform admin adds the shop member | Temporary password set during account creation; share securely and change after first sign-in |

Shop names and admin emails depend on the actual deployment database and are intentionally not guessed or committed here. Create the shops and members in `/admin/platform`; keep the private credential inventory outside Git.

Checkout submits orders to `POST /api/v1/orders`; customers can query them through `POST /api/v1/customer/order-lookup`. The admin dashboard uses this app's `/api/v1/admin` login, order-management, product-management, and profile endpoints.

New installations start with an empty shop catalog. Add verified listings, prices, inventory, and product images through the shop admin dashboard at `/admin`.

The storefront divides the home catalog between an initial product row and a second **More Products** row; this is a display split, not a claim about popularity or arrival dates. Product details, category listings, deals, the public shop directory, and individual shop profiles have separate shareable URLs (`/product/<id>`, `/category/<id>`, `/deals`, `/shops`, and `/shops/<slug>`). Each shop-specific page preserves its shop context with `?shop=<slug>` where needed. The `/about` and `/find-order` pages provide store information and order lookup. Search covers product names, categories, and descriptions; both product rows support wishlist actions. The storefront navigation collapses into an accessible menu on smaller screens.

## Multi-shop management

Open `/admin/platform` after signing in to create storefronts, switch the active shop, manage its users and roles, configure up to five hero slides with individual desktop images, optional mobile images, headlines, descriptions, and Buy Now URLs, set a separate store banner, record manual transactions, publish offers, and review shop-scoped reports and activity. Shops share one PostgreSQL database; each product and order carries a `shop_id`, and shop URLs use `/?shop=<slug>`. Existing products and orders are migrated into the `main` shop. The regular `/admin` dashboard uses the active shop selected in Shop management for both its product and order APIs.

Shop owners can add/remove shop members and change their admin/staff roles. Admins can manage shop settings, products, branding, transactions, and offers; staff can read shop data and process order-status/payment-review actions, but cannot change shop settings, catalog, branding, transactions, offers, or memberships. The platform does not provide account self-registration, email-based invitations, password-reset delivery, or ownership transfer. Account creation uses an owner-supplied temporary password, which must be shared securely and changed by the user after sign-in.

Each shop admin can create and rename shop-specific product categories. When deleting a category, the admin can either keep its products as uncategorized for later reassignment or delete those products and their images. Product listings support up to 10 JPEG, PNG, or WebP images (5 MB each); uploads are validated and resized to fit within 1600 × 1600 pixels, and storefront product pages display them as a gallery. The shop profile form manages the public shop name, description, location, contact email, phone, WhatsApp contact, and logo. The public `/shops/<slug>` page displays this profile with shop categories, products, offers, and top products.

The payment ledger is manual bookkeeping only; it does not connect to bKash, banks, or another payment provider. Reported order values represent order records, not collected cash. Verified/refund/expense entries in the ledger must be reconciled with the external payment records.

Offer feeds are public at `/api/v1/shops/<slug>/offers`. Browser push is optional and requires `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT` in the server environment; configure all three together. A browser subscription can follow more than one shop. Publishing an offer that is already active sends a push to current subscribers. Future-dated offers become visible when their start time arrives, but this release does not schedule a push for that future time; publish the offer when it is active if a push alert is required. Customers can enable or disable alerts independently for each shop.

Shop activity records successful logins/logouts and supported shop, member, product, order, offer, branding, and transaction changes. It is an operational audit trail, not a tamper-proof compliance log; retain database backups and restrict database access.

## Order management

- Orders are validated, priced against the server catalog, and persisted in PostgreSQL.
- Repeated checkout submissions with the same event ID and order details return the original order instead of creating duplicates. Reusing an event ID for different details is rejected.
- The cart and wishlist are saved in the current browser only; they are not linked to an account or synchronized across devices. The cart reconciles saved products with the current catalog, caps each product at 99 units and known stock, and blocks checkout when saved quantities are no longer available. The server independently enforces the same per-product limit and inventory at order placement.
- Customers can use **Find your order** in the storefront to look up an order using its order number and the checkout phone number; no account or registration is required. The lookup is rate-limited, is not cached, and returns only order items, totals, fulfillment status, and manual advance-review status (not delivery address or sender phone). Manual review is not payment-provider confirmation.
- After an order request is accepted, customers can download an HTML receipt containing the order number, customer/order summary, and totals. It confirms an order request only and is not proof of payment.
- The first admin email and password are seeded from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; passwords are stored as scrypt hashes. There is no public admin registration.
- The dashboard requires sign-in, supports status filtering and pagination, shows customer/item/payment-reference details, and updates order status through the enforced lifecycle: `new` → `confirmed` → `processing` → `shipped` → `delivered`. Orders can be cancelled before shipping; cancelled orders can only be reopened as `new`, with stock reserved again. Delivered orders are terminal; returns/refunds require a separate workflow.
- The authenticated **Products** admin section accepts JPEG, PNG, and WebP product images up to 5 MB, validates image signatures and product fields, saves product details in PostgreSQL and images in persistent storage, and publishes each product through the storefront catalog API. Admins can edit listing details, stock quantity, and purchase availability; replace an image; and delete products that should no longer be offered. Replaced and deleted images are removed from storage; cleanup failures are logged and surfaced in the dashboard. Product IDs, prices, inventory, and checkout availability are server-owned. Managed-product stock is reserved atomically when checkout accepts an order, so concurrent orders cannot oversell it; cancelling an order returns its reserved stock, and reopening it reserves that stock again or leaves the order cancelled if stock is no longer available. Legacy orders are not restocked because their inventory was not reserved. A database migration gives existing managed products zero stock, so set their actual stock in the admin dashboard before accepting orders. Deleting a product prevents new checkouts but does not alter historical order snapshots. Back up the `shopademia-product-images` Docker volume together with the database; local development stores images in the ignored `uploads/` directory.
- Admin order-status changes and manual advance-payment reviews are recorded in an order activity history with actor and before/after values. Existing orders have no historical events before this feature was deployed.
- The authenticated Admin profile section shows the account email and supports password changes. Passwords are stored as salted scrypt hashes; changing a password invalidates every active admin session. `ADMIN_EMAIL` and `ADMIN_PASSWORD` seed the account only when the database has no admin account; later password changes persist in the database and are not reset by app restarts or environment edits. The email is read-only in the dashboard; change it only through a planned, authenticated database maintenance operation.
- Admin sessions use signed eight-hour tokens tracked server-side; signing out revokes the current token, and changing a password invalidates all sessions. Customer order records are available only from authenticated admin endpoints.
- Order statuses: `new`, `confirmed`, `processing`, `shipped`, `delivered`, `cancelled`. Valid transitions are `new` → `confirmed` or `cancelled`; `confirmed` → `processing` or `cancelled`; `processing` → `shipped` or `cancelled`; `shipped` → `delivered`; and `cancelled` → `new`. Repeating the current status is an idempotent no-op.

The admin login is served on the same origin as the API. `/healthz` reports readiness only while PostgreSQL is reachable. The production Compose stack below keeps Node and PostgreSQL off the public host ports, places the database on a private Docker network, and configures the app to trust only its single Caddy proxy hop.

## Payment and launch requirements

There is **no bKash API integration**. Checkout collects the sender number as a reference only; the customer must wait for the store's payment instructions, and that number is not evidence of payment. Admins can record a manual advance review as verified or rejected, including reviewer and timestamp. Verify the transaction against your own bKash records before marking it verified. This review record is operational bookkeeping, not a payment-provider confirmation. The requested advance amount is served from `DELIVERY_ADVANCE_CHARGE`; it is not automatically deducted from the products due on delivery.

The storefront footer lists Shopademia's customer-support email, phone, and WhatsApp contact. Configure database backups, monitoring, and HTTPS on the production host before accepting orders. Review the bundled starter catalog and replace its sample listings with your own product details, prices, and inventory before accepting real orders.

## Production hardening checklist

### Self-hosted Docker deployment

This deployment targets a single Linux VM with Docker Compose and a public DNS name. It is deliberately single-app-instance because rate limits use per-process memory and the managed-product catalog/inventory has a process-local cache.

1. On an owner-verified Linux VM, point A/AAAA records for `shopademia.store`, `admin.shopademia.store`, and `api.shopademia.store` at that VM. Verify DNS and ownership before changing records. Allow inbound TCP ports 80 and 443; allow UDP 443 if HTTP/3 is desired. Install Docker Engine, the Docker Compose plugin, Git, and Node.js 20+ with npm for release/config validation.
2. Create the production environment file and edit it with unique values:

   ```sh
   cp .env.production.example .env.production
   chmod 600 .env.production
   ```

   Generate random secrets (run separately for every password and key):

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Create independent, high-entropy secrets for `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `POSTGRES_MIGRATION_PASSWORD`, `ADMIN_PASSWORD`, `JWT_SECRET`, and `MFA_ENCRYPTION_KEY`. Database passwords, JWT, and MFA keys must be 64-character hexadecimal values; the admin password must be unique and at least 64 characters. Set `SHOPADEMIA_RELEASE` to the exact 40–64-character Git commit SHA being released. Set the three exact domain variables and `ADMIN_SITE_URL` from `.env.production.example`. Put the app and migration passwords in `DATABASE_URL` and `MIGRATION_DATABASE_URL`, using their dedicated PostgreSQL roles. Install `age`, generate an encryption identity with `age-keygen`, keep its private identity separate from the VM, and set `BACKUP_AGE_RECIPIENT` to its public recipient. `ADMIN_SETTINGS_ENCRYPTION_KEY` is optional, but if used it must be unique and recoverable. Keep `.env.production` private; it is ignored by Git. Do not use the example placeholders as deployment configuration.
   For an existing database volume, take and verify a backup before the first deploy with these role changes. Run `chmod 700 scripts/upgrade-database-role.sh`, then `scripts/upgrade-database-role.sh`; review its confirmation prompt and set the migrator password/URL in `.env.production`. The script transfers ownership of objects in the `public` schema to `shopademia_migrator`, grants the app only data access, and removes the app's schema `CREATE` privilege.
3. Check out the specifically approved, clean release commit on the VPS. Set `SHOPADEMIA_RELEASE` to that commit's full SHA in `.env.production`, then validate the file and Compose model before building:

   ```sh
   git status --short
   git rev-parse HEAD
   npm ci
   npm run validate:production
   docker compose --env-file .env.production -f docker-compose.production.yml config --quiet
   docker compose --env-file .env.production -f docker-compose.production.yml build
   docker compose --env-file .env.production -f docker-compose.production.yml up -d
   docker compose --env-file .env.production -f docker-compose.production.yml ps
   ```

   The app and one-shot migrator use the same SHA-tagged image. The Compose project name is fixed so its named PostgreSQL, uploads, and Caddy volumes remain stable across release directories; do not override the project name. Caddy obtains and renews TLS certificates automatically after all three DNS names resolve to the verified VPS and ports are reachable. Do not publish Node or PostgreSQL ports; only Caddy exposes 80/443. `DATABASE_SSL=false` is allowed only over the isolated private Docker network. The Compose file keeps PostgreSQL authoritative and local to its private network.
4. Verify deployment:

   ```sh
   curl --fail --show-error https://shopademia.store/healthz
   curl --fail --show-error https://admin.shopademia.store/healthz
   curl --fail --show-error https://api.shopademia.store/healthz
   curl --fail --show-error https://shopademia.store/
   curl --fail --show-error https://admin.shopademia.store/admin
   ```

   All health endpoints should return HTTP 200 and `{"status":"ok"}`. Confirm the storefront is served only on the storefront host, admin sign-in and same-origin admin APIs work only on the admin host, and the API host returns only the documented public API/health paths. Test a real admin login only with the authorized initial admin account; do not use production customer data in smoke tests. Inspect sanitized service logs with `docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=100`.
5. Install `age` on the VM and create the backup directory for your deployment user. Test the encrypted backup command:

   ```sh
   chmod 700 scripts/backup-production.sh
   sudo install -d -m 700 -o "$USER" /var/backups/shopademia
   BACKUP_DIR=/var/backups/shopademia scripts/backup-production.sh
   ```

   The script creates a paired, timestamped, encrypted PostgreSQL dump and product-upload archive. Schedule it with the host's systemd timer or cron, retain both files together according to your policy, and copy the encrypted files to an off-host backup provider. Keep the age private key separately; without it, backups cannot be decrypted.

   First configure a separately isolated staging PostgreSQL service using `.env.staging`; start only the database under the restore-specific Compose project. The restore utility refuses a production environment, fixes the Compose file to the staging definition, and pins all database commands to the separate `shopademia-restore` project. Test a paired backup restore into that isolated database and a new directory (never the live uploads volume):

   ```sh
   chmod 700 scripts/restore-production.sh
   docker compose --project-name shopademia-restore --env-file .env.staging \
     -f docker-compose.staging.yml up --detach database
   RESTORE_ENV_FILE="$PWD/.env.staging" scripts/restore-production.sh \
     /var/backups/shopademia/shopademia-<timestamp>-<pid>.dump.age \
     /var/backups/shopademia/shopademia-<timestamp>-<pid>-uploads.tar.gz.age \
     /secure/off-host/age-identity.txt \
     /var/tmp/shopademia-restore-<date>
   ```

   The restore script accepts only the repository `.env.staging` file, runs the staging safety validator, and passes those values to Compose without sourcing or evaluating them as shell code. It requires `shopademia_staging_*` database and owner names, rejects non-local Docker contexts, decrypts both files, rejects unexpected archive paths and links, restores PostgreSQL into a newly named `shopademia_restore_*` database, and extracts uploads only beneath the new restore directory. It does not target the production Compose project. Verify the restored tables and files, document the result and recovery time, then have an operator remove the isolated test database and directory after review. Repeat this drill regularly.
6. Configure an external uptime monitor to request `https://<your-domain>/healthz`, alert on non-200 responses, and check service logs. Configure log retention, host patching, secret rotation, and an incident contact before opening the service to customers. Docker volumes are not encrypted by this Compose file: use a host/provider encrypted disk for the PostgreSQL volume and uploads, and verify that encryption remains enabled across recovery. The PostgreSQL volume is persistent but is not itself a backup.

Production platform administrators must enroll an authenticator app on their first sign-in and enter a current six-digit TOTP code on later sign-ins. Local development uses email and password only; this development-only mode does not disable or remove stored MFA enrollment, and the production server always requires MFA. Store `MFA_ENCRYPTION_KEY` separately from the database and back it up securely: losing or rotating it without decrypting/re-encrypting stored MFA secrets will lock platform administrators out. If an administrator loses their authenticator, use a documented, independently verified operator recovery procedure; there is no production email-based MFA bypass.

The platform admin's **Settings** panel supports ordinary JSON-compatible values and encrypted secret values. Secret writes are disabled until `ADMIN_SETTINGS_ENCRYPTION_KEY` is configured as a unique 64-character hexadecimal key. Keep it outside source control and separate from the database; losing it prevents recovery of saved setting secrets. Secret values are write-only in the current UI/API. Multi-key rotation and recovery tooling are not yet implemented.

The web process uses `shopademia_app`, which has schema usage and DML/sequence access only. A one-shot `migrate` service uses `shopademia_migrator` for schema changes and exits before the app starts; both passwords are distinct. PostgreSQL's bootstrap account creates the roles on a new database volume. The init script runs only when the database volume is first created, so use the confirmed upgrade script for an existing volume before deploying this change. The app has no published host port, and `TRUST_PROXY_HOPS=1` is correct only while Caddy is its sole trusted proxy. If you add another proxy/load balancer, update the hop count and ensure the proxy chain strips client-supplied forwarding headers.

Login and checkout are limited to 8 and 30 requests per client IP per 15 minutes, respectively. Order lookup allows 5 requests and product uploads 10 per IP per 15 minutes; public catalog reads allow 120 per minute. These limits are in-memory and reset on restart; do not scale to multiple app replicas without adding a shared rate-limit store, and add edge-level abuse controls if traffic warrants them.

### Retired deployment path

The cPanel deployment job and its instructions are retired and removed from the active CI workflow. Production releases must use the manually authorized Docker VPS procedure above; do not recreate or enable a cPanel deployment workflow.

### Launch blockers for real commerce

Before accepting real orders, load verified business products and inventory, test database restore and order recovery, configure actual off-host backup storage and uptime alerts, and review local privacy/tax/consumer requirements. Payments remain manual: train staff to compare sender numbers and transactions in the bKash merchant records, and never treat the dashboard's manual status as provider verification.

Run backend validation and route tests with `npm test`.
