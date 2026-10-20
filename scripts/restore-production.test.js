import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function pathForBash(path) {
    if (process.platform !== 'win32' || path === '') return path;
    const result = spawnSync('wsl.exe', ['--exec', 'wslpath', '-a', path], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function runRestore({ rootDir = root, envFile = '', nodePath = '' } = {}) {
    const command = 'cd -- "$1" || exit; PATH="$7:$PATH" RESTORE_ENV_FILE="$2" bash scripts/restore-production.sh "$3" "$4" "$5" "$6"';
    const shell = process.platform === 'win32' ? 'wsl.exe' : 'bash';
    const shellPrefix = process.platform === 'win32' ? ['--exec', 'bash'] : [];
    return spawnSync(shell, [
        ...shellPrefix,
        '-c',
        command,
        'restore-test',
        pathForBash(rootDir),
        pathForBash(envFile),
        'missing-database.dump.age',
        'missing-uploads.tar.gz.age',
        'missing-age-identity',
        'missing-restore-directory',
        pathForBash(nodePath)
    ], { encoding: 'utf8' });
}

test('restore refuses to use production defaults when no isolated env is supplied', () => {
    const result = runRestore();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RESTORE_ENV_FILE must name an authorized isolated staging environment/);
});

test('restore rejects a noncanonical environment file before validation or Docker', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'shopademia-restore-test-'));
    try {
        const absoluteEnvPath = resolve(directory, '.env.restore');
        await writeFile(absoluteEnvPath, 'POSTGRES_DB=shopademia_prod\nPOSTGRES_USER=shopademia_staging_owner\n');
        const result = runRestore({ envFile: absoluteEnvPath });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /must be the project \.env\.staging file validated by the staging safety checks/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('restore validates .env.staging without evaluating shell expressions in it', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'shopademia-restore-test-'));
    const scripts = resolve(directory, 'scripts');
    const bin = resolve(directory, 'bin');
    const marker = resolve(directory, 'shell-expression-executed');
    try {
        await mkdir(scripts);
        await mkdir(bin);
        await copyFile(resolve(root, 'scripts/restore-production.sh'), resolve(scripts, 'restore-production.sh'));
        await writeFile(resolve(directory, 'docker-compose.staging.yml'), 'services: {}\n');
        await writeFile(resolve(bin, 'node'), '#!/bin/sh\nprintf "validator ran\\n"\nexit 1\n');
        await chmod(resolve(bin, 'node'), 0o755);
        await writeFile(resolve(directory, '.env.staging'), `STAGING_OPERATOR=$(touch ${pathForBash(marker)})\n`);

        const result = runRestore({ rootDir: directory, envFile: resolve(directory, '.env.staging'), nodePath: bin });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /validator ran/, result.stderr);
        assert.match(result.stderr, /failed the project safety validator/);
        await assert.rejects(readFile(marker));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('restore is pinned to the isolated staging Compose project', async () => {
    const script = await readFile(resolve(root, 'scripts/restore-production.sh'), 'utf8');
    assert.match(script, /COMPOSE_FILE="\$ROOT_DIR\/docker-compose\.staging\.yml"/);
    assert.match(script, /docker compose --project-name shopademia-restore --env-file "\$RESTORE_ENV_FILE" -f "\$COMPOSE_FILE"/);
    assert.doesNotMatch(script, /docker-compose\.production\.yml|\.env\.production/);
    assert.doesNotMatch(script, /\bsource\s+/);
});
