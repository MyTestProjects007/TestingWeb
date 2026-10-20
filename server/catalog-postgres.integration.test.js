import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from './app.js';
import { getManagedProducts, setManagedProducts } from './catalog.js';

const enabled = process.env.SHOPADEMIA_CATALOG_PG_TEST === '1';
const databaseUrl = process.env.SHOPADEMIA_CATALOG_PG_DATABASE_URL;
const expectedDatabase = process.env.SHOPADEMIA_CATALOG_PG_DATABASE;
const expectedRole = process.env.SHOPADEMIA_CATALOG_PG_ROLE;
const isolatedDatabase = 'shopademia_catalog_consistency_test';
const isolatedRole = 'shopademia_catalog_test_role';
const shopId = '00000000-0000-4000-8000-000000000001';

function assertCatalogIntegrationTarget(databaseUrl) {
    const parsedUrl = new URL(databaseUrl);
    assert.ok(['postgres:', 'postgresql:'].includes(parsedUrl.protocol));
    assert.equal(parsedUrl.hostname, '127.0.0.1',
        'Catalog PostgreSQL integration tests require a loopback database.');
    assert.equal(parsedUrl.port, '55442',
        'Catalog PostgreSQL integration tests require the isolated test port 55442.');
    assert.equal(decodeURIComponent(parsedUrl.username), isolatedRole,
        'Catalog PostgreSQL integration tests require the dedicated test role.');
    assert.equal(parsedUrl.pathname, `/${isolatedDatabase}`,
        'Catalog PostgreSQL integration tests require the marked test database.');
    assert.equal(parsedUrl.search, '',
        'Catalog PostgreSQL integration tests do not allow connection-string query overrides.');
    assert.equal(parsedUrl.hash, '',
        'Catalog PostgreSQL integration tests do not allow connection-string fragments.');
    return parsedUrl;
}

test('PostgreSQL integration target rejects the unknown local database port', () => {
    assert.doesNotThrow(() => assertCatalogIntegrationTarget(
        `postgresql://${isolatedRole}:unused@127.0.0.1:55442/${isolatedDatabase}`
    ));
    assert.throws(() => assertCatalogIntegrationTarget(
        `postgresql://${isolatedRole}:unused@127.0.0.1:5432/${isolatedDatabase}`
    ), /isolated test port 55442/);
    for (const host of ['localhost', '192.0.2.1', 'database.example.com']) {
        assert.throws(() => assertCatalogIntegrationTarget(
            `postgresql://${isolatedRole}:unused@${host}:55442/${isolatedDatabase}`
        ), /require a loopback database/);
    }
    assert.throws(() => assertCatalogIntegrationTarget(
        `postgresql://other-role:unused@127.0.0.1:55442/${isolatedDatabase}`
    ), /require the dedicated test role/);
    assert.throws(() => assertCatalogIntegrationTarget(
        `postgresql://${isolatedRole}:unused@127.0.0.1:55442/other-database`
    ), /require the marked test database/);
    for (const override of [
        '?host=database.example.com',
        '?hostaddr=192.0.2.10',
        '?options=-c%20default_transaction_read_only%3Doff',
        '#other-database'
    ]) {
        assert.throws(() => assertCatalogIntegrationTarget(
            `postgresql://${isolatedRole}:unused@127.0.0.1:55442/${isolatedDatabase}${override}`
        ), /do not allow connection-string (query overrides|fragments)/);
    }
});

test('PostgreSQL checkout reads current product state and prevents concurrent oversell', { skip: !enabled }, async (t) => {
    assert.ok(databaseUrl && expectedDatabase && expectedRole,
        'Explicit isolated PostgreSQL URL, database name, and role are required.');
    assert.equal(expectedDatabase, isolatedDatabase,
        'Catalog PostgreSQL integration tests require the marked integration database.');
    assert.equal(expectedRole, isolatedRole,
        'Catalog PostgreSQL integration tests require the dedicated non-privileged role.');
    assertCatalogIntegrationTarget(databaseUrl);

    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const previousProducts = getManagedProducts();
    const fixturePrefix = randomUUID();
    const productIds = ['price', 'archived', 'unavailable', 'concurrent']
        .map((suffix) => `admin-${randomUUID()}`);
    const eventIds = [0, 1, 2, 3, 4].map(() => `catalog-${randomUUID()}`);
    let fixtureCreated = false;
    t.after(async () => {
        try {
            if (fixtureCreated) {
                const { rows: orders } = await pool.query(
                    'SELECT order_number FROM orders WHERE shop_id = $1 AND event_id = ANY($2::TEXT[])',
                    [shopId, eventIds]
                );
                const orderNumbers = orders.map(({ order_number: orderNumber }) => orderNumber);
                if (orderNumbers.length) {
                    await pool.query(
                        `DELETE FROM shop_activity_logs
                         WHERE shop_id = $1 AND entity_type = 'order' AND entity_id = ANY($2::TEXT[])`,
                        [shopId, orderNumbers]
                    );
                }
                await pool.query('DELETE FROM orders WHERE shop_id = $1 AND event_id = ANY($2::TEXT[])', [shopId, eventIds]);
                await pool.query('DELETE FROM managed_products WHERE id = ANY($1::TEXT[])', [productIds]);
            }
        } finally {
            setManagedProducts(previousProducts);
            await pool.end();
        }
    });

    const { rows: [identity] } = await pool.query(`
        SELECT current_database() AS database_name,
               current_user AS role_name,
               host(inet_server_addr()) AS server_address,
               shobj_description(db.oid, 'pg_database') AS database_marker,
               shobj_description(role.oid, 'pg_authid') AS role_marker,
               role.rolsuper AS is_superuser,
               role.rolcreatedb AS can_create_database,
               role.rolcreaterole AS can_create_role,
               current_setting('transaction_read_only') AS transaction_read_only
        FROM pg_database db
        JOIN pg_roles role ON role.rolname = current_user
        WHERE db.datname = current_database()
    `);
    assert.equal(identity.database_name, expectedDatabase);
    assert.equal(identity.role_name, expectedRole);
    assert.equal(identity.server_address, '127.0.0.1');
    assert.match(identity.database_marker ?? '', /^SHOPADEMIA_CATALOG_CONSISTENCY_TEST$/);
    assert.match(identity.role_marker ?? '', /^SHOPADEMIA_CATALOG_TEST_ROLE$/);
    assert.equal(identity.is_superuser, false);
    assert.equal(identity.can_create_database, false);
    assert.equal(identity.can_create_role, false);
    assert.equal(identity.transaction_read_only, 'off');
    const { rows: shops } = await pool.query(
        "SELECT id FROM shops WHERE id = $1 AND status = 'active'",
        [shopId]
    );
    assert.equal(shops.length, 1, 'The isolated database must already contain the active default shop.');

    const staleProducts = productIds.map((id, index) => ({
        id,
        name: `Catalog consistency fixture ${index}`,
        description: 'Synthetic integration fixture.',
        price: 100,
        oldPrice: null,
        category: 'gadgets',
        image: `https://images.example.invalid/${fixturePrefix}-${index}.png`,
        stockQuantity: index === 3 ? 1 : 2,
        isAvailable: true,
        isArchived: false,
        shopId
    }));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [index, product] of staleProducts.entries()) {
            await client.query(
                `INSERT INTO managed_products (id, name, description, price, category, image,
                                               stock_quantity, is_available, is_archived, shop_id)
                 VALUES ($1, $2, $3, 100, $4, $5, $6, TRUE, FALSE, $7)`,
                [product.id, product.name, product.description, product.category, product.image,
                    product.stockQuantity, shopId]
            );
            if (index === 0) {
                await client.query('UPDATE managed_products SET price = 250 WHERE id = $1', [product.id]);
            } else if (index === 1) {
                await client.query('UPDATE managed_products SET is_archived = TRUE WHERE id = $1', [product.id]);
            } else if (index === 2) {
                await client.query('UPDATE managed_products SET is_available = FALSE WHERE id = $1', [product.id]);
            }
        }
        await client.query('COMMIT');
        fixtureCreated = true;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    setManagedProducts([...previousProducts, ...staleProducts]);

    const appConfig = {
        nodeEnv: 'test',
        jwtSecret: 'isolated-catalog-integration-test-secret',
        advanceCharge: 100,
        trustProxyHops: 0
    };
    const appA = createApp({ pool, config: appConfig });
    const appB = createApp({ pool, config: appConfig });
    const checkout = (app, productId, eventId) => request(app).post('/api/v1/orders').send({
        customer: { name: 'Integration Test', phone: '01712345678', address: 'Isolated PostgreSQL fixture address' },
        payment: { method: 'bkash', bkashNumber: '01812345678' },
        items: [{ productId, quantity: 1 }],
        eventId,
        source: 'storefront'
    });

    const freshPrice = await checkout(appA, productIds[0], eventIds[0]).expect(201);
    assert.equal(freshPrice.body.data.subtotal, 250);
    await checkout(appA, productIds[1], eventIds[1]).expect(400);
    await checkout(appA, productIds[2], eventIds[2]).expect(409);

    const results = await Promise.allSettled([
        checkout(appA, productIds[3], eventIds[3]),
        checkout(appB, productIds[3], eventIds[4])
    ]);
    const statuses = results.map((result) => result.status === 'fulfilled' ? result.value.status : null).sort();
    assert.deepEqual(statuses, [201, 409]);
    const { rows: [raceOrders] } = await pool.query(
        'SELECT COUNT(*)::INTEGER AS count FROM orders WHERE shop_id = $1 AND event_id = ANY($2::TEXT[])',
        [shopId, eventIds.slice(3)]
    );
    assert.equal(raceOrders.count, 1);
    const { rows: [concurrentProduct] } = await pool.query(
        'SELECT stock_quantity FROM managed_products WHERE id = $1',
        [productIds[3]]
    );
    assert.equal(Number(concurrentProduct.stock_quantity), 0);
});
