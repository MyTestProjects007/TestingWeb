import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSslConfigurationError, parseDatabaseSsl } from './databaseSsl.js';

const migrationEntryPoint = fileURLToPath(new URL('./migrate.js', import.meta.url));

test('database SSL parser accepts only explicit supported values', () => {
    for (const [value, expected] of [
        ['', false],
        [' true ', true],
        ['TRUE', true],
        ['1', true],
        ['false', false],
        ['FALSE', false],
        ['0', false]
    ]) {
        assert.equal(parseDatabaseSsl(value), expected);
    }
    assert.throws(() => parseDatabaseSsl('enabled'), DatabaseSslConfigurationError);
});

test('migration job rejects invalid DATABASE_SSL before requiring credentials or connecting', () => {
    const databaseUrl = 'postgresql://migration-test:synthetic-canary@127.0.0.1:55441/staging_preview';
    const result = spawnSync(process.execPath, [migrationEntryPoint], {
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: 10_000,
        env: {
            PATH: process.env.PATH || '',
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            NODE_ENV: 'production',
            DATABASE_SSL: 'enabled',
            MIGRATION_DATABASE_URL: databaseUrl
        }
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /DATABASE_SSL must be set to true, false, 1, or 0/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-canary|postgresql:\/\//);
});
