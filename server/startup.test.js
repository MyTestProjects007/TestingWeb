import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entryPoint = fileURLToPath(new URL('./index.js', import.meta.url));

async function runStartup(environment) {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'shopademia-startup-test-'));
    try {
        const result = spawnSync(process.execPath, [entryPoint], {
            cwd: workingDirectory,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
                PATH: process.env.PATH || '',
                ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                ...environment
            }
        });
        assert.equal(result.error, undefined, result.error?.message);
        return { ...result, output: `${result.stdout}${result.stderr}` };
    } finally {
        await rm(workingDirectory, { recursive: true, force: true });
    }
}

test('startup reports a missing mandatory configuration name without exposing configuration values', async () => {
    const result = await runStartup({ NODE_ENV: 'production' });
    assert.equal(result.status, 1);
    assert.match(result.output, /DATABASE_URL must be set/);
    assert.doesNotMatch(result.output, /postgres(?:ql)?:\/\/|password|token/i);
});

test('startup rejects invalid DATABASE_SSL instead of silently disabling TLS', async () => {
    const result = await runStartup({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://staging_role:startup-test-canary@127.0.0.1:55441/staging_preview',
        DATABASE_SSL: 'enabled',
        PUBLIC_SITE_URL: 'https://staging.example.net',
        ADMIN_SITE_URL: 'https://admin.staging.example.net',
        JWT_SECRET: 'j'.repeat(64),
        MFA_ENCRYPTION_KEY: 'a'.repeat(64)
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /DATABASE_SSL must be set to true, false, 1, or 0/);
    assert.doesNotMatch(result.output, /startup-test-canary|postgresql:\/\//);
});

test('startup rejects a relative uploads directory before contacting PostgreSQL', async () => {
    const databaseUrl = 'postgresql://staging-test:synthetic-canary@127.0.0.1:55441/staging_preview';
    const result = await runStartup({
        NODE_ENV: 'production',
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: 'true',
        JWT_SECRET: 'j'.repeat(64),
        MFA_ENCRYPTION_KEY: 'a'.repeat(64),
        PUBLIC_SITE_URL: 'https://preview.example.net',
        ADMIN_SITE_URL: 'https://admin.preview.example.net',
        UPLOADS_DIR: 'relative/uploads'
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /UPLOADS_DIR must be an absolute path to persistent upload storage/);
    assert.doesNotMatch(result.output, /synthetic-canary|postgresql:\/\//);
});
