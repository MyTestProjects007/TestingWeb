import { createHash } from 'node:crypto';
import { ADMIN_MIGRATIONS } from './adminMigrations.js';

const expectedDatabase = 'shopademia_browser_preview';
const expectedRole = 'shopademia_preview_ro';
const readOnlyPreviewExactPaths = new Set([
    '/',
    '/shops',
    '/deals',
    '/about',
    '/privacy',
    '/terms',
    '/service-worker.js',
    '/robots.txt',
    '/sitemap.xml',
    '/404',
    '/healthz',
    '/api/v1/products',
    '/api/v1/products/hero-offer',
    '/api/v1/categories',
    '/api/v1/shops',
    '/api/v1/storefront-config',
    '/api/v1/storefront-announcement',
    '/api/v1/discounted-products'
]);
const expectedColumns = [
    ['shops', 'id'], ['shops', 'slug'], ['shops', 'status'],
    ['admin_users', 'id'], ['admin_users', 'email'], ['admin_users', 'session_version'],
    ['admin_users', 'mfa_enabled'], ['admin_users', 'mfa_secret'], ['admin_users', 'last_mfa_counter'],
    ['admin_sessions', 'token_id'], ['admin_sessions', 'expires_at'], ['admin_sessions', 'revoked_at'],
    ['admin_sessions', 'user_id'], ['admin_sessions', 'shop_id'],
    ['platform_admins', 'user_id'],
    ['shop_memberships', 'user_id'], ['shop_memberships', 'shop_id'], ['shop_memberships', 'role'],
    ['managed_products', 'id'], ['managed_products', 'name'], ['managed_products', 'description'],
    ['managed_products', 'image_alt'], ['managed_products', 'seo_title'], ['managed_products', 'meta_description'],
    ['managed_products', 'price'], ['managed_products', 'old_price'], ['managed_products', 'category'],
    ['managed_products', 'image'], ['managed_products', 'images'], ['managed_products', 'stock_quantity'],
    ['managed_products', 'is_available'], ['managed_products', 'shop_id'], ['managed_products', 'created_at'],
    ['orders', 'id'], ['orders', 'order_number'], ['orders', 'customer_name'], ['orders', 'phone'],
    ['orders', 'address'], ['orders', 'bkash_number'], ['orders', 'items'], ['orders', 'subtotal'],
    ['orders', 'advance_amount'], ['orders', 'due_amount'], ['orders', 'status'],
    ['orders', 'advance_payment_status'], ['orders', 'advance_payment_checked_at'],
    ['orders', 'advance_payment_checked_by'], ['orders', 'created_at'], ['orders', 'updated_at'],
    ['orders', 'shop_id']
];
const requiredReadColumns = [
    ['schema_migrations', 'version'], ['schema_migrations', 'checksum'],
    ['shops', 'id'], ['shops', 'slug'], ['shops', 'name'], ['shops', 'status'],
    ['shops', 'advance_charge'], ['shops', 'description'], ['shops', 'location'],
    ['shops', 'contact_email'], ['shops', 'contact_phone'], ['shops', 'contact_whatsapp'],
    ['shops', 'logo_image'], ['shops', 'hero_image'], ['shops', 'banner_image'],
    ['managed_products', 'id'], ['managed_products', 'name'], ['managed_products', 'description'],
    ['managed_products', 'image_alt'], ['managed_products', 'seo_title'], ['managed_products', 'meta_description'],
    ['managed_products', 'price'], ['managed_products', 'old_price'], ['managed_products', 'category'],
    ['managed_products', 'image'], ['managed_products', 'images'], ['managed_products', 'stock_quantity'],
    ['managed_products', 'is_available'], ['managed_products', 'is_archived'],
    ['managed_products', 'shop_id'], ['managed_products', 'created_at'],
    ['shop_product_categories', 'id'], ['shop_product_categories', 'name'],
    ['shop_product_categories', 'description'], ['shop_product_categories', 'icon'],
    ['shop_product_categories', 'is_active'], ['shop_product_categories', 'shop_id'],
    ['shop_hero_slides', 'id'], ['shop_hero_slides', 'position'], ['shop_hero_slides', 'image'],
    ['shop_hero_slides', 'mobile_image'], ['shop_hero_slides', 'headline'],
    ['shop_hero_slides', 'body_text'], ['shop_hero_slides', 'button_text'],
    ['shop_hero_slides', 'target_url'], ['shop_hero_slides', 'shop_id'],
    ['shop_offers', 'id'], ['shop_offers', 'title'], ['shop_offers', 'message'],
    ['shop_offers', 'image'], ['shop_offers', 'starts_at'], ['shop_offers', 'ends_at'],
    ['shop_offers', 'shop_id'], ['shop_offers', 'is_published'], ['shop_offers', 'created_at']
];

const requiredMigrationChecksums = new Map([
    ['000_legacy_baseline', createHash('sha256').update('shopademia-legacy-schema-baseline-v1').digest('hex')],
    ...ADMIN_MIGRATIONS.map(({ version, sql }) => [version, createHash('sha256').update(sql).digest('hex')])
]);

export function resolveReadOnlyPreviewMode(value) {
    if (value === undefined) return false;
    if (value === '1') return true;
    throw new Error('SHOPADEMIA_READ_ONLY_PREVIEW must be unset or exactly 1.');
}

export function validateReadOnlyPreviewConfig({ nodeEnv, host, port, databaseUrl, databaseSsl, trustProxyHops }) {
    let parsed;
    try {
        parsed = new URL(databaseUrl);
        if (decodeURIComponent(parsed.username) !== expectedRole || parsed.search || parsed.hash) throw new Error();
    } catch {
        throw new Error('Read-only preview mode requires the verified isolated PostgreSQL target.');
    }
    if (nodeEnv !== 'development' || host !== '127.0.0.1' || port !== 3002
        || !['postgres:', 'postgresql:'].includes(parsed.protocol)
        || parsed.hostname !== '127.0.0.1' || parsed.port !== '55441'
        || parsed.pathname !== `/${expectedDatabase}` || databaseSsl
        || trustProxyHops !== 0) {
        throw new Error('Read-only preview mode requires the verified isolated PostgreSQL target and loopback-only app binding.');
    }
}

export async function verifyReadOnlyPreviewDatabase(pool) {
    const { rows: [identity] } = await pool.query(`
        SELECT current_database() AS database_name,
               current_user AS role_name,
               host(inet_server_addr()) AS server_address,
               inet_server_port() AS server_port,
               current_setting('search_path') AS configured_search_path,
               current_schemas(false) AS effective_schemas,
               current_setting('default_transaction_read_only') AS read_only,
               role.rolsuper AS is_superuser,
               role.rolinherit AS inherits_role_memberships,
               role.rolcreatedb AS can_create_database,
               role.rolcreaterole AS can_create_role,
               role.rolreplication AS can_replicate,
               role.rolbypassrls AS can_bypass_row_security,
               has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_database,
               has_database_privilege(current_user, current_database(), 'TEMP') AS can_create_temporary_objects,
               (SELECT datdba = role.oid FROM pg_database WHERE datname = current_database()) AS owns_database,
               has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public_schema,
               (SELECT nspowner = role.oid FROM pg_namespace WHERE nspname = 'public') AS owns_public_schema,
               COALESCE((
                   SELECT bool_or(has_schema_privilege(current_user, namespace.oid, 'CREATE'))
                   FROM pg_namespace namespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
               ), false) AS can_create_user_schemas,
               COALESCE((
                   SELECT bool_or(namespace.nspowner = role.oid)
                   FROM pg_namespace namespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
               ), false) AS owns_user_schemas,
               EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = role.oid) AS has_role_memberships,
               COALESCE((
                   SELECT bool_or(has_table_privilege(current_user, relation.oid, 'INSERT'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_insert_user_relations,
               COALESCE((
                   SELECT bool_or(has_any_column_privilege(current_user, relation.oid, 'INSERT'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_insert_user_columns,
               COALESCE((
                   SELECT bool_or(has_table_privilege(current_user, relation.oid, 'UPDATE'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_update_user_relations,
               COALESCE((
                   SELECT bool_or(has_any_column_privilege(current_user, relation.oid, 'UPDATE'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_update_user_columns,
               COALESCE((
                   SELECT bool_or(has_table_privilege(current_user, relation.oid, 'DELETE'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_delete_user_relations,
               COALESCE((
                   SELECT bool_or(has_table_privilege(current_user, relation.oid, 'TRUNCATE'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_truncate_user_relations,
               COALESCE((
                   SELECT bool_or(has_table_privilege(current_user, relation.oid, 'REFERENCES'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_reference_user_relations,
               COALESCE((
                   SELECT bool_or(has_any_column_privilege(current_user, relation.oid, 'REFERENCES'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_reference_user_columns,
               COALESCE((
                   SELECT bool_or(has_table_privilege(current_user, relation.oid, 'TRIGGER'))
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS can_create_user_triggers,
               COALESCE((
                   SELECT bool_or(relation.relowner = role.oid)
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               ), false) AS owns_user_relations,
               EXISTS (
                   SELECT 1
                   FROM pg_proc routine
                   JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND routine.proowner = role.oid
               ) AS owns_user_routines,
               EXISTS (
                   SELECT 1
                   FROM pg_proc routine
                   JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND has_function_privilege(current_user, routine.oid, 'EXECUTE')
               ) AS can_execute_user_routines,
               EXISTS (
                   SELECT 1
                   FROM pg_type object_type
                   JOIN pg_namespace namespace ON namespace.oid = object_type.typnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND object_type.typowner = role.oid
               ) AS owns_user_types,
               COALESCE((
                   SELECT bool_or(has_sequence_privilege(current_user, sequence.oid, 'SELECT'))
                   FROM pg_class sequence
                   JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND sequence.relkind = 'S'
               ), false) AS can_select_user_sequences,
               COALESCE((
                   SELECT bool_or(has_sequence_privilege(current_user, sequence.oid, 'USAGE'))
                   FROM pg_class sequence
                   JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND sequence.relkind = 'S'
               ), false) AS can_use_user_sequences,
               COALESCE((
                   SELECT bool_or(has_sequence_privilege(current_user, sequence.oid, 'UPDATE'))
                   FROM pg_class sequence
                   JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND sequence.relkind = 'S'
               ), false) AS can_update_user_sequences,
               COALESCE((
                   SELECT bool_or(sequence.relowner = role.oid)
                   FROM pg_class sequence
                   JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
                   WHERE namespace.nspname !~ '^pg_'
                     AND namespace.nspname <> 'information_schema'
                     AND sequence.relkind = 'S'
               ), false) AS owns_user_sequences
        FROM pg_roles role
        WHERE role.rolname = current_user
    `);
    if (identity?.database_name !== expectedDatabase || identity?.role_name !== expectedRole
        || identity?.server_address !== '127.0.0.1' || Number(identity?.server_port) !== 55441
        || identity?.configured_search_path !== 'public'
        || identity?.effective_schemas?.length !== 1 || identity.effective_schemas[0] !== 'public'
        || !['on', 'true', '1'].includes(identity?.read_only)
        || identity?.is_superuser !== false || identity?.inherits_role_memberships !== false
        || identity?.can_create_database !== false
        || identity?.can_create_role !== false || identity?.can_create_in_database !== false
        || identity?.can_create_temporary_objects !== false
        || identity?.can_replicate !== false || identity?.can_bypass_row_security !== false
        || identity?.owns_database !== false || identity?.can_create_in_public_schema !== false
        || identity?.owns_public_schema !== false || identity?.can_create_user_schemas !== false
        || identity?.owns_user_schemas !== false || identity?.has_role_memberships !== false
        || identity?.can_insert_user_relations !== false || identity?.can_insert_user_columns !== false
        || identity?.can_update_user_relations !== false || identity?.can_update_user_columns !== false
        || identity?.can_delete_user_relations !== false || identity?.can_truncate_user_relations !== false
        || identity?.can_reference_user_relations !== false || identity?.can_reference_user_columns !== false
        || identity?.can_create_user_triggers !== false
        || identity?.owns_user_relations !== false || identity?.owns_user_routines !== false
        || identity?.can_execute_user_routines !== false
        || identity?.owns_user_types !== false || identity?.can_select_user_sequences !== false
        || identity?.can_use_user_sequences !== false
        || identity?.can_update_user_sequences !== false || identity?.owns_user_sequences !== false) {
        throw new Error('Read-only preview mode could not verify the isolated, read-only PostgreSQL target.');
    }

    const requiredVersions = [...requiredMigrationChecksums.keys()];
    const { rows: migrations } = await pool.query(
        'SELECT version, checksum FROM schema_migrations WHERE version = ANY($1::text[])',
        [requiredVersions]
    );
    const migrationChecksums = new Map(migrations.map(({ version, checksum }) => [version, checksum]));
    if (requiredVersions.some((version) => migrationChecksums.get(version) !== requiredMigrationChecksums.get(version))) {
        throw new Error('Read-only preview mode requires the verified application schema migrations.');
    }

    const tableNames = expectedColumns.map(([table]) => table);
    const columnNames = expectedColumns.map(([, column]) => column);
    const { rows: foundColumns } = await pool.query(`
        WITH required(table_name, column_name) AS (
            SELECT * FROM unnest($1::text[], $2::text[])
        )
        SELECT required.table_name, required.column_name
        FROM required
        LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
        LEFT JOIN pg_class relation
          ON relation.relnamespace = namespace.oid
         AND relation.relname = required.table_name
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        LEFT JOIN pg_attribute actual
          ON actual.attrelid = relation.oid
         AND actual.attname = required.column_name
         AND actual.attnum > 0
         AND NOT actual.attisdropped
        WHERE actual.attname IS NULL
    `, [tableNames, columnNames]);
    if (foundColumns.length) {
        throw new Error('Read-only preview mode requires the compatible admin API schema.');
    }

    const readTableNames = requiredReadColumns.map(([table]) => table);
    const readColumnNames = requiredReadColumns.map(([, column]) => column);
    const { rows: [readAccess] } = await pool.query(`
        WITH required_read(table_name, column_name) AS (
            SELECT * FROM unnest($1::text[], $2::text[])
        )
        SELECT EXISTS (
            SELECT 1
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            JOIN pg_attribute actual ON actual.attrelid = relation.oid
            WHERE namespace.nspname !~ '^pg_'
              AND namespace.nspname <> 'information_schema'
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND actual.attnum > 0
              AND NOT actual.attisdropped
              AND has_column_privilege(current_user, relation.oid, actual.attnum, 'SELECT')
              AND NOT EXISTS (
                  SELECT 1 FROM required_read
                  WHERE namespace.nspname = 'public'
                    AND required_read.table_name = relation.relname
                    AND required_read.column_name = actual.attname
              )
        ) AS has_unapproved_select_access,
        EXISTS (
            SELECT 1
            FROM required_read
            LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
            LEFT JOIN pg_class relation
              ON relation.relnamespace = namespace.oid
             AND relation.relname = required_read.table_name
             AND relation.relkind IN ('r', 'p')
            LEFT JOIN pg_attribute actual
              ON actual.attrelid = relation.oid
             AND actual.attname = required_read.column_name
             AND actual.attnum > 0
             AND NOT actual.attisdropped
            WHERE actual.attname IS NULL
               OR NOT has_column_privilege(current_user, relation.oid, actual.attnum, 'SELECT')
        ) AS has_missing_required_select_access
    `, [readTableNames, readColumnNames]);
    if (readAccess?.has_unapproved_select_access !== false
        || readAccess?.has_missing_required_select_access !== false) {
        throw new Error('Read-only preview could not verify least-privilege access to required application reads.');
    }
}

export function isReadOnlyPreviewRequest(method, path) {
    if (!['GET', 'HEAD'].includes(method)) return false;
    return readOnlyPreviewExactPaths.has(path)
        || /^\/(?:product|category)\/[^/]+$/.test(path)
        || /^\/shops\/[a-z0-9][a-z0-9-]{1,47}$/.test(path)
        || /^\/api\/v1\/(?:public\/)?shops\/[a-z0-9][a-z0-9-]{1,47}(?:\/(?:products(?:\/hero-offer)?|categories|config|offers))?$/.test(path)
        || /^\/(?:css|js|public-assets|uploads)\/[^/]+(?:\/[^/]+)*$/.test(path);
}
