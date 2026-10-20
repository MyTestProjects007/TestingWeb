import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ADMIN_MIGRATIONS } from './adminMigrations.js';
import {
    isReadOnlyPreviewRequest,
    resolveReadOnlyPreviewMode,
    validateReadOnlyPreviewConfig,
    verifyReadOnlyPreviewDatabase
} from './readOnlyPreview.js';

function previewDatabaseUrl({ role = 'shopademia_preview_ro', host = '127.0.0.1', port = '55441',
    database = 'shopademia_browser_preview', search = '', hash = '' } = {}) {
    const url = new URL(`postgresql://${host}:${port}/${database}`);
    url.username = role;
    url.search = search;
    url.hash = hash;
    return url.href;
}

const validConfig = {
    nodeEnv: 'development',
    host: '127.0.0.1',
    port: 3002,
    databaseUrl: previewDatabaseUrl(),
    databaseSsl: false,
    trustProxyHops: 0
};

test('read-only preview mode fails closed on ambiguous flag values', () => {
    assert.equal(resolveReadOnlyPreviewMode(undefined), false);
    assert.equal(resolveReadOnlyPreviewMode('1'), true);
    for (const value of ['', '0', 'true', 'yes']) {
        assert.throws(() => resolveReadOnlyPreviewMode(value), /must be unset or exactly 1/);
    }
});

test('read-only preview config is restricted to the verified loopback app and database', () => {
    assert.doesNotThrow(() => validateReadOnlyPreviewConfig(validConfig));
    for (const override of [
        { nodeEnv: 'production' },
        { host: '0.0.0.0' },
        { port: 3000 },
        { databaseUrl: validConfig.databaseUrl.replace('55441', '5432') },
        { databaseUrl: previewDatabaseUrl({ role: 'shopademia_browser_preview' }) },
        { databaseUrl: previewDatabaseUrl({ database: 'other' }) },
        { databaseUrl: previewDatabaseUrl({ host: '192.0.2.10' }) },
        { databaseUrl: previewDatabaseUrl({ port: '5432' }) },
        { databaseUrl: previewDatabaseUrl({ search: '?hostaddr=192.0.2.10' }) },
        { databaseUrl: previewDatabaseUrl({ hash: '#other-database' }) },
        { databaseUrl: previewDatabaseUrl({ search: '?options=-c%20default_transaction_read_only%3Doff' }) },
        { databaseSsl: true },
        { trustProxyHops: 1 }
    ]) {
        assert.throws(
            () => validateReadOnlyPreviewConfig({ ...validConfig, ...override }),
            /verified isolated PostgreSQL target|loopback-only app binding/
        );
    }
});

test('read-only preview admits only safe GET/HEAD API routes', () => {
    for (const [method, path] of [
        ['GET', '/healthz'],
        ['GET', '/'],
        ['HEAD', '/product/synthetic-product'],
        ['GET', '/category/gadgets'],
        ['GET', '/shops'],
        ['GET', '/shops/main'],
        ['GET', '/service-worker.js'],
        ['GET', '/css/styles.css'],
        ['GET', '/js/main.js'],
        ['GET', '/public-assets/favicon.svg'],
        ['HEAD', '/api/v1/products'],
        ['HEAD', '/api/v1/shops/main/products'],
        ['HEAD', '/css/styles.css'],
        ['GET', '/api/v1/products/hero-offer'],
        ['GET', '/api/v1/categories'],
        ['GET', '/api/v1/shops'],
        ['GET', '/api/v1/shops/main'],
        ['GET', '/api/v1/shops/main/products'],
        ['GET', '/api/v1/shops/main/products/hero-offer'],
        ['GET', '/api/v1/shops/main/categories'],
        ['GET', '/api/v1/shops/main/config'],
        ['GET', '/api/v1/storefront-announcement'],
        ['GET', '/api/v1/discounted-products'],
        ['GET', '/api/v1/shops/main/offers'],
        ['GET', '/api/v1/public/shops/main/products']
    ]) assert.equal(isReadOnlyPreviewRequest(method, path), true);

    for (const [method, path] of [
        ['POST', '/api/v1/admin/login'],
        ['POST', '/api/v1/orders'],
        ['POST', '/api/v1/customer/order-lookup'],
        ['POST', '/api/v1/shops/main/push-subscriptions'],
        ['GET', '/api/v1/shops/main/push-subscriptions'],
        ['GET', '/api/v1/shops/main/push-key'],
        ['GET', '/api/v1/shops/main/push-key/extra'],
        ['GET', '/api/v1/shops/main/members'],
        ['HEAD', '/api/v1/admin/dashboard'],
        ['HEAD', '/api/v1/orders'],
        ['HEAD', '/api/v1/customer/order-lookup'],
        ['GET', '/find-order'],
        ['GET', '/top-selling'],
        ['GET', '/api/v1/top-selling'],
        ['GET', '/api/v1/admin/dashboard'],
        ['GET', '/api/v1/admin/profile'],
        ['GET', '/api/v1/admin/products'],
        ['GET', '/api/v1/admin/products/synthetic-product'],
        ['GET', '/api/v1/admin/orders'],
        ['GET', '/api/v1/admin/orders/123'],
        ['GET', '/admin'],
        ['GET', '/admin-assets/admin.js'],
        ['PATCH', '/api/v1/admin/products/synthetic-product'],
        ['DELETE', '/api/v1/admin/products/synthetic-product'],
        ['GET', '/api/v1/admin/products/synthetic-product/upload'],
        ['GET', '/not-a-storefront-route']
    ]) assert.equal(isReadOnlyPreviewRequest(method, path), false);
});

test('read-only preview validates target identity, schema migrations, and required columns using SELECT only', async () => {
    const baselineChecksum = createHash('sha256')
        .update('shopademia-legacy-schema-baseline-v1')
        .digest('hex');
    const migrationRows = [
        { version: '000_legacy_baseline', checksum: baselineChecksum },
        ...ADMIN_MIGRATIONS.map(({ version, sql }) => ({
            version,
            checksum: createHash('sha256').update(sql).digest('hex')
        }))
    ];
    const statements = [];
    const queryValues = [];
    let readAccess = {
        has_unapproved_select_access: false,
        has_missing_required_select_access: false
    };
    const pool = {
        async query(sql, values) {
            statements.push(sql);
            queryValues.push(values);
            if (sql.includes('current_database()')) {
                return { rows: [{
                    database_name: 'shopademia_browser_preview',
                    role_name: 'shopademia_preview_ro',
                    server_address: '127.0.0.1',
                    server_port: 55441,
                    configured_search_path: 'public',
                    effective_schemas: ['public'],
                    read_only: 'on',
                    is_superuser: false,
                    inherits_role_memberships: false,
                    can_create_database: false,
                    can_create_role: false,
                    can_replicate: false,
                    can_bypass_row_security: false,
                    can_create_in_database: false,
                    can_create_temporary_objects: false,
                    owns_database: false,
                    can_create_in_public_schema: false,
                    owns_public_schema: false,
                    can_create_user_schemas: false,
                    owns_user_schemas: false,
                    has_role_memberships: false,
                    can_insert_user_relations: false,
                    can_insert_user_columns: false,
                    can_update_user_relations: false,
                    can_update_user_columns: false,
                    can_delete_user_relations: false,
                    can_truncate_user_relations: false,
                    can_reference_user_relations: false,
                    can_reference_user_columns: false,
                    can_create_user_triggers: false,
                    owns_user_relations: false,
                    owns_user_routines: false,
                    can_execute_user_routines: false,
                    owns_user_types: false,
                    can_select_user_sequences: false,
                    can_use_user_sequences: false,
                    can_update_user_sequences: false,
                    owns_user_sequences: false
                }] };
            }
            if (sql.includes('FROM schema_migrations')) return { rows: migrationRows };
            if (sql.includes('has_unapproved_select_access')) return { rows: [readAccess] };
            if (sql.includes('pg_attribute actual')) return { rows: [] };
            throw new Error('Unexpected query in read-only schema verification.');
        }
    };

    await assert.doesNotReject(verifyReadOnlyPreviewDatabase(pool));
    assert.equal(statements.length, 4);
    assert.ok(statements.every((sql) => /^\s*(SELECT|WITH)\b/i.test(sql)));
    assert.ok(statements[2].includes('LEFT JOIN pg_attribute actual'));
    assert.ok(statements[3].includes("has_column_privilege(current_user, relation.oid, actual.attnum, 'SELECT')"));
    assert.ok(statements[3].includes('has_unapproved_select_access'));
    assert.ok(statements[3].includes('has_missing_required_select_access'));
    assert.match(statements[3], /AND relation\.relkind IN \('r', 'p'\)/);
    assert.deepEqual([...new Set(queryValues[3][0])].sort(), [
        'managed_products',
        'schema_migrations',
        'shop_hero_slides',
        'shop_offers',
        'shop_product_categories',
        'shops'
    ]);
    assert.equal(queryValues[3][0].includes('orders'), false);
    assert.equal(queryValues[3][0].includes('admin_settings'), false);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.ok(statements[0].includes(
            `has_table_privilege(current_user, relation.oid, '${privilege}')`
        ));
    }
    for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES']) {
        assert.ok(statements[0].includes(
            `has_any_column_privilege(current_user, relation.oid, '${privilege}')`
        ));
    }
    assert.ok(statements[0].includes("has_database_privilege(current_user, current_database(), 'TEMP')"));
    assert.ok(statements[0].includes("has_schema_privilege(current_user, namespace.oid, 'CREATE')"));
    assert.ok(statements[0].includes('namespace.nspname !~ \'^pg_\''));
    assert.ok(statements[0].includes("namespace.nspname <> 'information_schema'"));
    assert.ok(statements[0].includes('namespace.nspowner = role.oid'));
    assert.equal((statements[0].match(/namespace\.nspname !~ '\^pg_'/g) || []).length, 19);
    assert.ok(statements[0].includes('routine.proowner = role.oid'));
    assert.ok(statements[0].includes("current_setting('search_path') AS configured_search_path"));
    assert.ok(statements[0].includes('current_schemas(false) AS effective_schemas'));
    assert.ok(statements[0].includes('has_function_privilege(current_user, routine.oid, \'EXECUTE\')'));
    assert.ok(statements[0].includes('object_type.typowner = role.oid'));
    for (const privilege of ['SELECT', 'USAGE', 'UPDATE']) {
        assert.ok(statements[0].includes(
            `has_sequence_privilege(current_user, sequence.oid, '${privilege}')`
        ));
    }
    readAccess = { ...readAccess, has_unapproved_select_access: true };
    await assert.rejects(
        verifyReadOnlyPreviewDatabase(pool),
        /least-privilege access to required application reads/
    );
    readAccess = {
        has_unapproved_select_access: false,
        has_missing_required_select_access: true
    };
    await assert.rejects(
        verifyReadOnlyPreviewDatabase(pool),
        /least-privilege access to required application reads/
    );
    readAccess = undefined;
    await assert.rejects(
        verifyReadOnlyPreviewDatabase(pool),
        /least-privilege access to required application reads/
    );

    pool.query = async (sql) => {
        if (sql.includes('current_database()')) {
            return { rows: [{
                database_name: 'shopademia_browser_preview',
                role_name: 'shopademia_preview_ro',
                server_address: '127.0.0.1',
                server_port: 55441,
                configured_search_path: 'public',
                effective_schemas: ['public'],
                read_only: 'on',
                is_superuser: false,
                inherits_role_memberships: true,
                can_create_database: false,
                can_create_role: true,
                can_replicate: false,
                can_bypass_row_security: false,
                can_create_in_database: false,
                can_create_temporary_objects: false,
                owns_database: true,
                can_create_in_public_schema: true,
                owns_public_schema: true,
                has_role_memberships: true,
                can_insert_user_relations: true,
                can_insert_user_columns: true,
                can_update_user_relations: true,
                can_update_user_columns: true,
                can_delete_user_relations: true,
                can_truncate_user_relations: true,
                can_reference_user_relations: true,
                can_reference_user_columns: true,
                can_create_user_triggers: true,
                owns_user_relations: true,
                owns_user_routines: true,
                can_execute_user_routines: true,
                owns_user_types: true,
                can_select_user_sequences: true,
                can_use_user_sequences: true,
                can_update_user_sequences: true,
                owns_user_sequences: true
            }] };
        }
        throw new Error('Verification must stop when the preview role has write privileges.');
    };
    await assert.rejects(verifyReadOnlyPreviewDatabase(pool), /could not verify the isolated, read-only PostgreSQL target/);

    pool.query = async (sql) => {
        if (sql.includes('current_database()')) {
            return { rows: [{ database_name: 'wrong_database' }] };
        }
        throw new Error('Verification must stop after a mismatched target identity.');
    };
    await assert.rejects(verifyReadOnlyPreviewDatabase(pool), /could not verify the isolated, read-only PostgreSQL target/);
});

test('read-only preview rejects every unsafe database identity and effective privilege', async () => {
    const safeIdentity = {
        database_name: 'shopademia_browser_preview',
        role_name: 'shopademia_preview_ro',
        server_address: '127.0.0.1',
        server_port: 55441,
        configured_search_path: 'public',
        effective_schemas: ['public'],
        read_only: 'on',
        is_superuser: false,
        inherits_role_memberships: false,
        can_create_database: false,
        can_create_role: false,
        can_replicate: false,
        can_bypass_row_security: false,
        can_create_in_database: false,
        can_create_temporary_objects: false,
        owns_database: false,
        can_create_in_public_schema: false,
        owns_public_schema: false,
        can_create_user_schemas: false,
        owns_user_schemas: false,
        has_role_memberships: false,
        can_insert_user_relations: false,
        can_insert_user_columns: false,
        can_update_user_relations: false,
        can_update_user_columns: false,
        can_delete_user_relations: false,
        can_truncate_user_relations: false,
        can_reference_user_relations: false,
        can_reference_user_columns: false,
        can_create_user_triggers: false,
        owns_user_relations: false,
        owns_user_routines: false,
        can_execute_user_routines: false,
        owns_user_types: false,
        can_select_user_sequences: false,
        can_use_user_sequences: false,
        can_update_user_sequences: false,
        owns_user_sequences: false
    };
    const unsafeOverrides = [
        ['unexpected runtime role', { role_name: 'shopademia_browser_preview' }],
        ['unexpected database', { database_name: 'other_database' }],
        ['unexpected database host', { server_address: '192.0.2.10' }],
        ['unexpected database port', { server_port: 5432 }],
        ['missing configured search_path', { configured_search_path: undefined }],
        ['unresolved search_path entry', { configured_search_path: '$user, public' }],
        ['unexpected effective search path', { effective_schemas: ['preview', 'public'] }],
        ['missing effective schema result', { effective_schemas: undefined }],
        ['non-read-only transaction default', { read_only: 'off' }],
        ['superuser', { is_superuser: true }],
        ['role inheritance', { inherits_role_memberships: true }],
        ['role membership', { has_role_memberships: true }],
        ['database creation', { can_create_database: true }],
        ['role creation', { can_create_role: true }],
        ['replication', { can_replicate: true }],
        ['row-security bypass', { can_bypass_row_security: true }],
        ['database CREATE privilege', { can_create_in_database: true }],
        ['temporary-object CREATE privilege', { can_create_temporary_objects: true }],
        ['database ownership', { owns_database: true }],
        ['schema CREATE privilege', { can_create_in_public_schema: true }],
        ['schema ownership', { owns_public_schema: true }],
        ['CREATE in a non-public schema', { can_create_user_schemas: true }],
        ['ownership of a non-public schema', { owns_user_schemas: true }],
        ['INSERT privilege in a user schema', { can_insert_user_relations: true }],
        ['column-level INSERT privilege in a user schema', { can_insert_user_columns: true }],
        ['UPDATE privilege in a user schema', { can_update_user_relations: true }],
        ['column-level UPDATE privilege in a user schema', { can_update_user_columns: true }],
        ['DELETE privilege in a user schema', { can_delete_user_relations: true }],
        ['TRUNCATE privilege in a user schema', { can_truncate_user_relations: true }],
        ['REFERENCES privilege in a user schema', { can_reference_user_relations: true }],
        ['column-level REFERENCES privilege in a user schema', { can_reference_user_columns: true }],
        ['TRIGGER privilege in a user schema', { can_create_user_triggers: true }],
        ['relation ownership in a user schema', { owns_user_relations: true }],
        ['routine ownership in a user schema', { owns_user_routines: true }],
        ['executable invoker routine in a user schema', { can_execute_user_routines: true }],
        ['type ownership in a user schema', { owns_user_types: true }],
        ['sequence SELECT privilege in a user schema', { can_select_user_sequences: true }],
        ['sequence USAGE privilege in a user schema', { can_use_user_sequences: true }],
        ['sequence UPDATE privilege in a user schema', { can_update_user_sequences: true }],
        ['sequence ownership in a user schema', { owns_user_sequences: true }]
    ];

    for (const [description, override] of unsafeOverrides) {
        const pool = {
            async query(sql) {
                if (sql.includes('current_database()')) {
                    return { rows: [{ ...safeIdentity, ...override }] };
                }
                throw new Error(`Verification must stop for ${description}.`);
            }
        };
        await assert.rejects(
            verifyReadOnlyPreviewDatabase(pool),
            /could not verify the isolated, read-only PostgreSQL target/,
            description
        );
    }
});
