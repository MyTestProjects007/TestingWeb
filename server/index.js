import 'dotenv/config';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { validateAdminPassword } from './adminPassword.js';
import { createApp } from './app.js';
import { setManagedProducts } from './catalog.js';
import { DatabaseSslConfigurationError, parseDatabaseSsl } from './databaseSsl.js';
import { initializeDatabase, loadManagedProducts } from './db.js';
import {
    resolveReadOnlyPreviewMode,
    validateReadOnlyPreviewConfig,
    verifyReadOnlyPreviewDatabase
} from './readOnlyPreview.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

class StartupConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StartupConfigurationError';
    }
}

class HostConfigurationError extends StartupConfigurationError {
    constructor() {
        super('HOST must be an IP address.');
        this.name = 'HostConfigurationError';
    }
}

function required(name, minimumLength = 1) {
    const value = process.env[name]?.trim();
    if (!value || value.length < minimumLength) {
        throw new StartupConfigurationError(`${name} must be set and contain at least ${minimumLength} characters.`);
    }
    return value;
}

async function start() {
    let readOnlyPreview;
    try {
        readOnlyPreview = resolveReadOnlyPreviewMode(process.env.SHOPADEMIA_READ_ONLY_PREVIEW);
    } catch {
        throw new StartupConfigurationError('SHOPADEMIA_READ_ONLY_PREVIEW must be unset or exactly 1.');
    }
    let databaseSsl;
    try {
        databaseSsl = parseDatabaseSsl(process.env.DATABASE_SSL);
    } catch (error) {
        if (!(error instanceof DatabaseSslConfigurationError)) throw error;
        throw new StartupConfigurationError(error.message);
    }
    const config = {
        nodeEnv: process.env.NODE_ENV || 'development',
        adminMfaRequired: (process.env.NODE_ENV || 'development') === 'production',
        port: Number(process.env.PORT || 3000),
        host: process.env.HOST?.trim() || undefined,
        trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),
        siteUrl: process.env.PUBLIC_SITE_URL?.trim() || null,
        adminSiteUrl: process.env.ADMIN_SITE_URL?.trim() || null,
        databaseUrl: required('DATABASE_URL'),
        databaseSsl,
        jwtSecret: required('JWT_SECRET', 32),
        advanceCharge: Number(process.env.DELIVERY_ADVANCE_CHARGE || 100),
        vapidPublicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() || null,
        vapidPrivateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() || null,
        vapidSubject: process.env.WEB_PUSH_VAPID_SUBJECT?.trim() || null,
        adminSettingsEncryptionKey: process.env.ADMIN_SETTINGS_ENCRYPTION_KEY?.trim() || ''
    };
    const mfaEncryptionKey = process.env.MFA_ENCRYPTION_KEY?.trim() || '';
    if (config.nodeEnv === 'production' && !mfaEncryptionKey) {
        throw new StartupConfigurationError('MFA_ENCRYPTION_KEY must be set in production to protect platform-admin authenticator secrets.');
    }
    if (mfaEncryptionKey && !/^[0-9a-f]{64}$/i.test(mfaEncryptionKey)) {
        throw new StartupConfigurationError('MFA_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
    }
    config.mfaEncryptionKey = mfaEncryptionKey
        ? Buffer.from(mfaEncryptionKey, 'hex')
        : createHash('sha256').update(`shopademia-mfa-encryption\0${config.jwtSecret}`).digest();
    if (config.adminSettingsEncryptionKey && !/^[0-9a-f]{64}$/i.test(config.adminSettingsEncryptionKey)) {
        throw new StartupConfigurationError('ADMIN_SETTINGS_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
    }
    config.adminSettingsEncryptionKey = config.adminSettingsEncryptionKey
        ? Buffer.from(config.adminSettingsEncryptionKey, 'hex')
        : null;
    if (!['development', 'production', 'test'].includes(config.nodeEnv)) {
        throw new StartupConfigurationError('NODE_ENV must be one of development, production, or test.');
    }
    if (config.siteUrl) {
        let siteUrl;
        try {
            siteUrl = new URL(config.siteUrl);
        } catch {
            throw new StartupConfigurationError('PUBLIC_SITE_URL must be a valid absolute HTTP(S) origin.');
        }
        if (!['http:', 'https:'].includes(siteUrl.protocol) || siteUrl.origin !== config.siteUrl.replace(/\/+$/, '')) {
            throw new StartupConfigurationError('PUBLIC_SITE_URL must be an absolute HTTP(S) origin without a path, query, or fragment.');
        }
        config.siteUrl = siteUrl.origin;
    } else if (config.nodeEnv === 'production') {
        throw new StartupConfigurationError('PUBLIC_SITE_URL must be set in production for canonical URLs and the sitemap.');
    }
    if (config.adminSiteUrl) {
        let adminSiteUrl;
        try {
            adminSiteUrl = new URL(config.adminSiteUrl);
        } catch {
            throw new StartupConfigurationError('ADMIN_SITE_URL must be a valid absolute HTTP(S) origin.');
        }
        if (!['http:', 'https:'].includes(adminSiteUrl.protocol)
            || adminSiteUrl.origin !== config.adminSiteUrl.replace(/\/+$/, '')) {
            throw new StartupConfigurationError('ADMIN_SITE_URL must be an absolute HTTP(S) origin without a path, query, or fragment.');
        }
        if (config.nodeEnv === 'production' && adminSiteUrl.protocol !== 'https:') {
            throw new StartupConfigurationError('ADMIN_SITE_URL must use HTTPS in production.');
        }
        if (config.siteUrl && adminSiteUrl.hostname !== `admin.${new URL(config.siteUrl).hostname}`) {
            throw new StartupConfigurationError('ADMIN_SITE_URL must use the admin subdomain of PUBLIC_SITE_URL.');
        }
        config.adminSiteUrl = adminSiteUrl.origin;
    } else if (config.nodeEnv === 'production') {
        throw new StartupConfigurationError('ADMIN_SITE_URL must be set in production to protect admin browser sessions.');
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        throw new StartupConfigurationError('PORT must be a valid TCP port.');
    }
    if (config.host && !isIP(config.host)) throw new HostConfigurationError();
    if (!Number.isInteger(config.trustProxyHops) || config.trustProxyHops < 0 || config.trustProxyHops > 10) {
        throw new StartupConfigurationError('TRUST_PROXY_HOPS must be an integer from 0 to 10.');
    }
    if (readOnlyPreview) validateReadOnlyPreviewConfig(config);
    if (!Number.isSafeInteger(config.advanceCharge) || config.advanceCharge < 0) {
        throw new StartupConfigurationError('DELIVERY_ADVANCE_CHARGE must be a non-negative integer.');
    }
    if (Boolean(config.vapidPublicKey) !== Boolean(config.vapidPrivateKey)
        || (config.vapidPublicKey && !config.vapidSubject)) {
        throw new StartupConfigurationError('Set WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY, and WEB_PUSH_VAPID_SUBJECT together to enable offer notifications.');
    }
    if (/replace-with|change-this/i.test(config.jwtSecret)) {
        throw new StartupConfigurationError('Replace the example JWT secret in .env before starting the server.');
    }
    const configuredUploadsDir = process.env.UPLOADS_DIR?.trim();
    if (configuredUploadsDir && !isAbsolute(configuredUploadsDir)) {
        throw new StartupConfigurationError('UPLOADS_DIR must be an absolute path to persistent upload storage.');
    }
    const uploadsDir = configuredUploadsDir ? resolve(configuredUploadsDir) : join(root, 'uploads');
    if (readOnlyPreview) {
        if (!(await stat(uploadsDir)).isDirectory()) throw new Error('Read-only preview mode requires the existing uploads directory.');
    } else {
        await mkdir(uploadsDir, { recursive: true });
    }

    const poolConfig = {
        connectionString: config.databaseUrl,
        max: 10,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
        idleTimeoutMillis: 30000,
        ...(readOnlyPreview ? { options: '-c default_transaction_read_only=on' } : {}),
        ...(config.databaseSsl ? { ssl: { rejectUnauthorized: true } } : {})
    };
    const pool = new Pool(poolConfig);
    pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', {
        name: error.name || 'Error',
        code: typeof error.code === 'string' ? error.code : undefined
    }));
    if (readOnlyPreview) {
        await verifyReadOnlyPreviewDatabase(pool);
    } else if (config.nodeEnv !== 'production') {
        const adminEmail = required('ADMIN_EMAIL');
        const adminPassword = required('ADMIN_PASSWORD', 12);
        validateAdminPassword(adminPassword);
        await initializeDatabase(pool, {
            email: adminEmail,
            password: adminPassword,
            advanceCharge: config.advanceCharge
        });
    }
    const managedProducts = await loadManagedProducts(pool);
    setManagedProducts(managedProducts);
    console.info(`Loaded ${managedProducts.length} admin-managed products.`);

    const app = createApp({ pool, config: { ...config, uploadsDir, readOnlyPreview } });
    const server = createServer(app);
    const displayHost = config.host
        ? (config.host.includes(':') ? `[${config.host}]` : config.host)
        : 'localhost';
    const onListening = () => console.info(`Shopademia listening on http://${displayHost}:${config.port}`);
    if (config.host) server.listen(config.port, config.host, onListening);
    else server.listen(config.port, onListening);

    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        const forceClose = setTimeout(() => {
            console.error('Graceful shutdown timed out; closing remaining HTTP connections.');
            server.closeAllConnections?.();
        }, 25_000);
        forceClose.unref();
        server.close(async (error) => {
            clearTimeout(forceClose);
            if (error) {
                console.error('HTTP server shutdown failed:', { name: error.name || 'Error', code: error.code });
                process.exitCode = 1;
            }
            try {
                await pool.end();
            } catch (poolError) {
                console.error('PostgreSQL pool shutdown failed:', {
                    name: poolError.name || 'Error',
                    code: typeof poolError.code === 'string' ? poolError.code : undefined
                });
                process.exitCode = 1;
            }
        });
        server.closeIdleConnections?.();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

start().catch((error) => {
    console.error('Shopademia server failed to start:', {
        name: error.name || 'Error',
        code: typeof error.code === 'string' ? error.code : undefined,
        ...(error instanceof StartupConfigurationError ? { message: error.message } : {})
    });
    process.exitCode = 1;
});
