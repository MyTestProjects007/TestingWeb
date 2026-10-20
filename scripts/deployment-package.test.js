import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    buildDeploymentPackage,
    verifyDeploymentPackage
} from './deployment-package.js';
import { runStagingPreflight, validateStagingEnvironment } from './staging-preflight.js';

async function writeFixtureFile(root, path, contents = `fixture:${path}\n`) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
}

async function makeFixture(root) {
    for (const path of [
        '.dockerignore',
        '404.html',
        'Caddyfile',
        'Dockerfile',
        'admin.html',
        'admin-platform.html',
        'docker-compose.production.yml',
        'docker-compose.staging.yml',
        'index.html',
        'service-worker.js',
        'package.json',
        'package-lock.json',
        'deployment/cpanel.env.example',
        'docs/CPANEL-DEPLOYMENT-RUNBOOK.md',
        'admin-assets/admin.js',
        'css/styles.css',
        'js/data/products.data.js',
        'public-assets/favicon.svg',
        'database/Dockerfile',
        'database/init/10-app-role.sh',
        'server/index.js',
        'server/app.js',
        'server/migrate.js',
        'server/migrations.js'
    ]) {
        await writeFixtureFile(root, path);
    }
    await writeFixtureFile(root, 'server/index.js', "import './app.js';\n");
    await writeFixtureFile(root, 'server/migrate.js', "import './migrations.js';\n");
    await writeFixtureFile(root, 'Dockerfile', 'COPY service-worker.js ./\n');
    await writeFixtureFile(root, 'package.json', JSON.stringify({ engines: { node: '>=20' } }));
    await writeFixtureFile(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3 }));
}

const stagingEnvironment = {
    NODE_ENV: 'production',
    PUBLIC_SITE_URL: 'https://preview.example.net',
    ADMIN_SITE_URL: 'https://admin.preview.example.net',
    UPLOADS_DIR: join(tmpdir(), 'shopademia-preview-uploads'),
    DATABASE_URL: 'postgresql://staging-role:dummy-password@db.preview.example.net:5432/preview',
    DATABASE_SSL: 'true',
    JWT_SECRET: 'j'.repeat(64),
    MFA_ENCRYPTION_KEY: 'a'.repeat(64)
};
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('deployment package is deterministic, manifest-verified, and excludes non-allowlisted data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shopademia-package-source-'));
    const outputRoot = await mkdtemp(join(tmpdir(), 'shopademia-package-output-'));
    try {
        await makeFixture(root);
        await writeFixtureFile(root, '.env.production', 'should-not-ship\n');
        await writeFixtureFile(root, 'node_modules/private/secret.js', 'should-not-ship\n');
        await writeFixtureFile(root, 'uploads/customer-image.png', 'should-not-ship\n');
        await writeFixtureFile(root, 'backups/database.dump', 'should-not-ship\n');
        await writeFixtureFile(root, 'server/app.test.js', 'should-not-ship\n');

        const first = await buildDeploymentPackage({ root, outputRoot });
        const second = await buildDeploymentPackage({ root, outputRoot });
        assert.equal(first.packageSha256, second.packageSha256);
        assert.equal(first.path, second.path);
        assert.equal((await verifyDeploymentPackage(first.path)).packageSha256, first.packageSha256);
        assert.match(first.path, /shopademia-production-/);

        const manifest = JSON.parse(await readFile(join(first.path, 'MANIFEST.json'), 'utf8'));
        const packagedPaths = manifest.files.map(({ path }) => path);
        for (const requiredPath of [
            'Caddyfile',
            'Dockerfile',
            'docker-compose.production.yml',
            'docker-compose.staging.yml',
            'database/Dockerfile',
            'database/init/10-app-role.sh',
            'service-worker.js',
            'package-lock.json',
            'server/app.js',
            'js/data/products.data.js'
        ]) {
            assert.ok(packagedPaths.includes(requiredPath), `Expected production input ${requiredPath}`);
        }
        assert.match(await readFile(resolve(repositoryRoot, 'Dockerfile'), 'utf8'), /^COPY service-worker\.js \.\/$/m);
        assert.ok(packagedPaths.includes('package-lock.json'));
        assert.ok(!packagedPaths.includes('deployment/cpanel.env.example'));
        assert.ok(!packagedPaths.includes('docs/CPANEL-DEPLOYMENT-RUNBOOK.md'));
        assert.ok(!packagedPaths.some((path) => /(?:^|\/)(?:\.env|node_modules|uploads|backups)(?:\/|$)/i.test(path)));
        assert.ok(!packagedPaths.some((path) => /\.(?:test|spec)\.[cm]?js$/i.test(path)));
        assert.ok(!packagedPaths.some((path) => /(?:dump|sqlite|\.db|\.zip|\.age)$/i.test(path)));
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outputRoot, { recursive: true, force: true });
    }
});

test('deployment package rejects sensitive files nested in packaged asset trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shopademia-package-sensitive-'));
    const outputRoot = await mkdtemp(join(tmpdir(), 'shopademia-package-output-'));
    try {
        await makeFixture(root);
        await writeFixtureFile(root, 'js/.env.production', 'private\n');
        await assert.rejects(
            buildDeploymentPackage({ root, outputRoot }),
            /Sensitive or non-runtime path found under packaged assets/
        );
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outputRoot, { recursive: true, force: true });
    }
});

test('deployment package verifier detects tampering and extra files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shopademia-package-tamper-'));
    const outputRoot = await mkdtemp(join(tmpdir(), 'shopademia-package-output-'));
    try {
        await makeFixture(root);
        const artifact = await buildDeploymentPackage({ root, outputRoot });
        await writeFile(join(artifact.path, 'index.html'), 'tampered');
        await assert.rejects(verifyDeploymentPackage(artifact.path), /integrity check failed/);

        await writeFixtureFile(artifact.path, 'index.html');
        await writeFile(join(artifact.path, 'unexpected.env'), 'private');
        await assert.rejects(verifyDeploymentPackage(artifact.path), /missing or unexpected files/);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outputRoot, { recursive: true, force: true });
    }
});

test('staging preflight validates package, toolchain, and config without exposing config values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shopademia-preflight-source-'));
    const outputRoot = await mkdtemp(join(tmpdir(), 'shopademia-preflight-output-'));
    try {
        await makeFixture(root);
        const artifact = await buildDeploymentPackage({ root, outputRoot });
        const result = await runStagingPreflight({
            packageDirectory: artifact.path,
            environment: stagingEnvironment,
            nodeVersion: 'v22.0.0',
            npmVersion: '10.0.0'
        });
        assert.deepEqual(result.errors, []);
        assert.ok(result.externalGates.length >= 5);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outputRoot, { recursive: true, force: true });
    }
});

test('staging preflight rejects production origins without echoing database or secret values', async () => {
    const errors = validateStagingEnvironment({
        ...stagingEnvironment,
        PUBLIC_SITE_URL: 'https://shopademia.store',
        ADMIN_SITE_URL: 'https://admin.shopademia.store'
    });
    const message = errors.join('\n');
    assert.match(message, /outside the production domain/);
    assert.doesNotMatch(message, /dummy-password|j{64}|a{64}|db\.preview/);
});

test('staging preflight rejects database URL query and fragment endpoint overrides', () => {
    for (const suffix of [
        '?host=production-db.example.net',
        '#production-db.example.net'
    ]) {
        const errors = validateStagingEnvironment({
            ...stagingEnvironment,
            DATABASE_URL: `${stagingEnvironment.DATABASE_URL}${suffix}`
        });
        assert.ok(errors.some((error) => /must not include query parameters or a fragment/.test(error)));
        assert.doesNotMatch(errors.join('\n'), /production-db\.example\.net/);
    }
});

test('staging preflight requires uploads storage outside the packaged release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shopademia-preflight-uploads-source-'));
    const outputRoot = await mkdtemp(join(tmpdir(), 'shopademia-preflight-uploads-output-'));
    try {
        await makeFixture(root);
        const artifact = await buildDeploymentPackage({ root, outputRoot });
        const relativeUploads = await runStagingPreflight({
            packageDirectory: artifact.path,
            environment: { ...stagingEnvironment, UPLOADS_DIR: 'uploads' },
            nodeVersion: 'v22.0.0',
            npmVersion: '10.0.0'
        });
        assert.ok(relativeUploads.errors.some((error) => /UPLOADS_DIR must be an absolute path/.test(error)));

        const packageUploads = await runStagingPreflight({
            packageDirectory: artifact.path,
            environment: { ...stagingEnvironment, UPLOADS_DIR: join(artifact.path, 'uploads') },
            nodeVersion: 'v22.0.0',
            npmVersion: '10.0.0'
        });
        assert.ok(packageUploads.errors.some((error) => /UPLOADS_DIR must be outside/.test(error)));
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outputRoot, { recursive: true, force: true });
    }
});
