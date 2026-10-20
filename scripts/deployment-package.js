import { createHash } from 'node:crypto';
import {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootFiles = [
    '.dockerignore',
    '404.html',
    'Caddyfile',
    'Dockerfile',
    'admin.html',
    'admin-platform.html',
    'docker-compose.production.yml',
    'docker-compose.staging.yml',
    'index.html',
    'package.json',
    'package-lock.json',
    'service-worker.js'
];
const staticDirectories = ['admin-assets', 'css', 'js', 'public-assets'];
const deploymentDirectories = ['database'];
const entryPoints = ['server/index.js', 'server/migrate.js'];
const manifestName = 'MANIFEST.json';
const forbiddenPath = /(?:^|\/)(?:\.env(?:\..*)?|\.git|node_modules|uploads|backups|coverage|test-results|playwright-report)(?:\/|$)|(?:^|\/)(?:credentials?|secrets?)(?:\.[^/]*)?$|\.(?:pem|key|p12|pfx|dump|sqlite|db|zip|tar|gz|age)$/i;
const excludedSourceTest = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?js$/i;

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

function toPosix(value) {
    return value.split(sep).join('/');
}

function comparePaths(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafePackagePath(packagePath) {
    if (typeof packagePath !== 'string' || packagePath === ''
        || packagePath.startsWith('/') || packagePath.includes('\\')
        || packagePath.split('/').some((part) => part === '' || part === '.' || part === '..')
        || forbiddenPath.test(packagePath)
        || excludedSourceTest.test(packagePath)) {
        throw new Error(`Unsafe or excluded path in deployment package: ${packagePath}`);
    }
}

async function addFile(files, root, packagePath) {
    const normalized = toPosix(packagePath);
    assertSafePackagePath(normalized);
    const absolutePath = resolve(root, ...normalized.split('/'));
    if (!isWithin(root, absolutePath)) throw new Error(`Package path escapes source root: ${normalized}`);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Deployment input must be a regular, non-symlink file: ${normalized}`);
    }
    files.set(normalized, absolutePath);
}

function isWithin(root, candidate) {
    const path = relative(root, candidate);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function addDirectory(files, root, packagePath) {
    const absoluteDirectory = resolve(root, ...packagePath.split('/'));
    const metadata = await lstat(absoluteDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`Deployment input must be a regular, non-symlink directory: ${packagePath}`);
    }

    async function walk(directory, relativeDirectory) {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => comparePaths(left.name, right.name));
        for (const entry of entries) {
            const childPath = `${relativeDirectory}/${entry.name}`;
            const normalized = toPosix(childPath);
            if (forbiddenPath.test(normalized)) {
                throw new Error(`Sensitive or non-runtime path found under packaged assets: ${normalized}`);
            }
            if (entry.name.startsWith('.')) continue;
            const absolutePath = join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in deployment inputs: ${normalized}`);
            if (entry.isDirectory()) {
                await walk(absolutePath, childPath);
            } else if (entry.isFile() && !excludedSourceTest.test(normalized)) {
                assertSafePackagePath(normalized);
                files.set(normalized, absolutePath);
            } else if (!entry.isFile()) {
                throw new Error(`Unsupported deployment input type: ${normalized}`);
            }
        }
    }

    await walk(absoluteDirectory, packagePath);
}

async function addRuntimeGraph(files, root) {
    const pending = [...entryPoints];
    const visited = new Set();
    const importPattern = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]((?:\.{1,2})\/[^'"]+)['"]/g;

    while (pending.length) {
        const packagePath = pending.pop();
        if (visited.has(packagePath)) continue;
        await addFile(files, root, packagePath);
        visited.add(packagePath);
        const source = await readFile(files.get(packagePath), 'utf8');
        for (const match of source.matchAll(importPattern)) {
            const importedPath = resolve(dirname(resolve(root, ...packagePath.split('/'))), match[1]);
            if (!isWithin(root, importedPath)) throw new Error(`Runtime import escapes source root from ${packagePath}`);
            const resolvedPath = importedPath.endsWith('.js') ? importedPath : `${importedPath}.js`;
            const childPath = toPosix(relative(root, resolvedPath));
            assertSafePackagePath(childPath);
            pending.push(childPath);
        }
    }
}

function createManifest(files) {
    const entries = files.map(({ path, size, sha256: checksum }) => ({ path, size, sha256: checksum }));
    const packageHash = sha256(JSON.stringify(entries));
    return {
        formatVersion: 1,
        packageSha256: packageHash,
        files: entries
    };
}

export async function collectDeploymentFiles(root = repositoryRoot) {
    const sourceRoot = resolve(root);
    const files = new Map();
    for (const packagePath of rootFiles) await addFile(files, sourceRoot, packagePath);
    for (const directory of staticDirectories) await addDirectory(files, sourceRoot, directory);
    for (const directory of deploymentDirectories) await addDirectory(files, sourceRoot, directory);
    await addRuntimeGraph(files, sourceRoot);
    return [...files.entries()]
        .map(([path, sourcePath]) => ({ path, sourcePath }))
        .sort((left, right) => comparePaths(left.path, right.path));
}

async function listArtifactFiles(root) {
    const found = [];
    async function walk(directory, relativeDirectory = '') {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const packagePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            const absolutePath = join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symlink: ${packagePath}`);
            if (entry.isDirectory()) {
                await walk(absolutePath, packagePath);
            } else if (entry.isFile()) {
                found.push(packagePath);
            } else {
                throw new Error(`Artifact contains an unsupported file type: ${packagePath}`);
            }
        }
    }
    await walk(root);
    return found.sort(comparePaths);
}

export async function verifyDeploymentPackage(packageDirectory) {
    const root = resolve(packageDirectory);
    const manifestPath = join(root, manifestName);
    const manifestMetadata = await lstat(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
        throw new Error('Deployment package manifest must be a regular, non-symlink file.');
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest?.formatVersion !== 1 || !Array.isArray(manifest.files)
        || typeof manifest.packageSha256 !== 'string') {
        throw new Error('Deployment package manifest has an unsupported format.');
    }

    const seen = new Set();
    const entries = [];
    for (const entry of manifest.files) {
        assertSafePackagePath(entry.path);
        if (seen.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0
            || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            throw new Error(`Deployment package manifest entry is invalid: ${entry.path}`);
        }
        seen.add(entry.path);
        const filePath = resolve(root, ...entry.path.split('/'));
        if (!isWithin(root, filePath)) throw new Error(`Deployment package path escapes its root: ${entry.path}`);
        const metadata = await lstat(filePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error(`Deployment package entry is not a regular, non-symlink file: ${entry.path}`);
        }
        const contents = await readFile(filePath);
        if (contents.byteLength !== entry.size || sha256(contents) !== entry.sha256) {
            throw new Error(`Deployment package integrity check failed: ${entry.path}`);
        }
        entries.push({ path: entry.path, size: entry.size, sha256: entry.sha256 });
    }
    const calculatedManifest = createManifest(entries);
    if (calculatedManifest.packageSha256 !== manifest.packageSha256) {
        throw new Error('Deployment package manifest checksum does not match its file list.');
    }

    const actualPaths = await listArtifactFiles(root);
    const expectedPaths = [...seen, manifestName].sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
        throw new Error('Deployment package contains missing or unexpected files.');
    }
    return { packageSha256: manifest.packageSha256, fileCount: entries.length };
}

export async function buildDeploymentPackage({
    root = repositoryRoot,
    outputRoot = join(repositoryRoot, 'release-artifacts')
} = {}) {
    const sourceRoot = resolve(root);
    const outputDirectory = resolve(outputRoot);
    await mkdir(outputDirectory, { recursive: true });
    const files = await collectDeploymentFiles(sourceRoot);
    const manifestEntries = [];
    for (const file of files) {
        const contents = await readFile(file.sourcePath);
        manifestEntries.push({ path: file.path, size: contents.byteLength, sha256: sha256(contents) });
    }
    const manifest = createManifest(manifestEntries);
    const targetDirectory = join(outputDirectory, `shopademia-production-${manifest.packageSha256.slice(0, 16)}`);

    try {
        const existing = await lstat(targetDirectory);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
            throw new Error('The deterministic deployment package path exists but is not a regular directory.');
        }
        const verified = await verifyDeploymentPackage(targetDirectory);
        if (verified.packageSha256 !== manifest.packageSha256) {
            throw new Error('The deterministic deployment package path contains different content; refusing to overwrite it.');
        }
        return { ...verified, path: targetDirectory };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const temporaryDirectory = await mkdtemp(join(outputDirectory, '.shopademia-package-'));
    try {
        for (const file of files) {
            const destination = join(temporaryDirectory, ...file.path.split('/'));
            await mkdir(dirname(destination), { recursive: true });
            await copyFile(file.sourcePath, destination);
        }
        await writeFile(join(temporaryDirectory, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
        const verified = await verifyDeploymentPackage(temporaryDirectory);
        if (verified.packageSha256 !== manifest.packageSha256) {
            throw new Error('Built deployment package failed its manifest verification.');
        }
        await rename(temporaryDirectory, targetDirectory);
        return { ...verified, path: targetDirectory };
    } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw error;
    }
}

async function main(args) {
    const [command, packagePath] = args;
    if (command === 'build' && args.length === 1) {
        const result = await buildDeploymentPackage();
        console.info(`Deployment package: ${result.path}`);
        console.info(`Files: ${result.fileCount}`);
        console.info(`Package SHA-256: ${result.packageSha256}`);
        return;
    }
    if (command === 'verify' && packagePath && args.length === 2) {
        const result = await verifyDeploymentPackage(packagePath);
        console.info(`Deployment package integrity verified: ${result.fileCount} files.`);
        console.info(`Package SHA-256: ${result.packageSha256}`);
        return;
    }
    throw new Error('Usage: node scripts/deployment-package.js build | verify <package-directory>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error) => {
        console.error('Deployment package operation failed:', error.message);
        process.exitCode = 1;
    });
}
