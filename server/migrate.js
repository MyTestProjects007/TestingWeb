import 'dotenv/config';
import { Pool } from 'pg';
import { validateAdminPassword } from './adminPassword.js';
import { DatabaseSslConfigurationError, parseDatabaseSsl } from './databaseSsl.js';
import { initializeDatabase } from './db.js';

function required(name, minimumLength = 1) {
    const value = process.env[name]?.trim();
    if (!value || value.length < minimumLength) {
        throw new Error(`${name} must be set and contain at least ${minimumLength} characters.`);
    }
    return value;
}

async function migrate() {
    const databaseSsl = parseDatabaseSsl(process.env.DATABASE_SSL);
    const environment = process.env.NODE_ENV || 'development';
    if (environment === 'production') {
        const adminPassword = required('ADMIN_PASSWORD', 12);
        const adminEmail = required('ADMIN_EMAIL');
        validateAdminPassword(adminPassword);
        const advanceCharge = Number(process.env.DELIVERY_ADVANCE_CHARGE || 100);
        if (!Number.isSafeInteger(advanceCharge) || advanceCharge < 0) {
            throw new Error('DELIVERY_ADVANCE_CHARGE must be a non-negative integer.');
        }
        const pool = new Pool({
            connectionString: required('MIGRATION_DATABASE_URL'),
            max: 2,
            connectionTimeoutMillis: 5000,
            statement_timeout: 30000,
            ...(databaseSsl ? { ssl: { rejectUnauthorized: true } } : {})
        });
        pool.on('error', (error) => console.error('Unexpected migration database error:', {
            name: error.name || 'Error',
            code: typeof error.code === 'string' ? error.code : undefined
        }));
        try {
            await initializeDatabase(pool, {
                email: adminEmail,
                password: adminPassword,
                advanceCharge
            });
            console.info('Database migration job completed.');
        } finally {
            await pool.end();
        }
        return;
    }
    throw new Error('The migration job is intended for the production deployment only.');
}

migrate().catch((error) => {
    console.error('Database migration job failed:', {
        name: error.name || 'Error',
        code: typeof error.code === 'string' ? error.code : undefined,
        ...(error instanceof DatabaseSslConfigurationError ? { message: error.message } : {})
    });
    process.exitCode = 1;
});
