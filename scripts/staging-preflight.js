import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDeploymentPackage } from './deployment-package.js';

const minimumNodeMajor = 20;
const minimumNpmMajor = 9;
const requiredConfiguration = [
    'DATABASE_URL',
    'DATABASE_SSL',
    'JWT_SECRET',
    'MFA_ENCRYPTION_KEY',
    'NODE_ENV',
    'PUBLIC_SITE_URL',
    'ADMIN_SITE_URL',
    'UPLOADS_DIR'
];
const externalGates = [
    'Provider-confirmed isolated staging runtime and all three host routes',
    'Independent staging PostgreSQL identity, version, and least-privilege grant verification',
    'Provider-confirmed persistent uploads path, permissions, quota, and backup coverage',
    'Verified database and uploads backups plus isolated restore and rehearsed rollback',
    'Isolated synthetic staging data with real payments and customer notifications disabled',
    'Monitoring/recovery evidence and explicit authorization for the staging change'
];

function parseMajor(version) {
    const match = /^v?(\d+)(?:\.|$)/.exec(version);
    return match ? Number(match[1]) : null;
}

function validStagingOrigins(environment, errors) {
    let publicUrl;
    let adminUrl;
    try {
        publicUrl = new URL(environment.PUBLIC_SITE_URL);
    } catch {
        errors.push('PUBLIC_SITE_URL must be a valid HTTPS staging origin.');
    }
    try {
        adminUrl = new URL(environment.ADMIN_SITE_URL);
    } catch {
        errors.push('ADMIN_SITE_URL must be a valid HTTPS staging origin.');
    }
    if (!publicUrl || !adminUrl) return;
    const productionHost = 'shopademia.store';
    const isProductionHost = (host) => host === productionHost || host.endsWith(`.${productionHost}`);
    if (publicUrl.protocol !== 'https:' || publicUrl.origin !== environment.PUBLIC_SITE_URL
        || isProductionHost(publicUrl.hostname.toLowerCase())) {
        errors.push('PUBLIC_SITE_URL must be an HTTPS origin outside the production domain.');
    }
    if (adminUrl.protocol !== 'https:' || adminUrl.origin !== environment.ADMIN_SITE_URL
        || adminUrl.hostname.toLowerCase() !== `admin.${publicUrl.hostname.toLowerCase()}`
        || isProductionHost(adminUrl.hostname.toLowerCase())) {
        errors.push('ADMIN_SITE_URL must be the HTTPS admin subdomain of the non-production staging origin.');
    }
}

function validDatabaseConfig(environment, errors) {
    let databaseUrl;
    try {
        databaseUrl = new URL(environment.DATABASE_URL);
    } catch {
        errors.push('DATABASE_URL must be a valid PostgreSQL connection URL; its value was not displayed.');
        return;
    }
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
        || !databaseUrl.hostname || !databaseUrl.pathname || databaseUrl.pathname === '/') {
        errors.push('DATABASE_URL must specify a PostgreSQL endpoint and database; its value was not displayed.');
    }
    if (databaseUrl.search || databaseUrl.hash) {
        errors.push('DATABASE_URL must not include query parameters or a fragment that can override the validated endpoint.');
    }
    if (!['true', 'false'].includes(environment.DATABASE_SSL.toLowerCase())) {
        errors.push('DATABASE_SSL must be explicitly set to true or false after provider confirmation.');
    }
}

export function validateStagingEnvironment(environment = process.env, packageDirectory) {
    const errors = [];
    const missing = requiredConfiguration.filter((name) => !environment[name]?.trim());
    if (missing.length) errors.push(`Required staging configuration is missing: ${missing.join(', ')}.`);
    const uploadsDirectory = environment.UPLOADS_DIR?.trim();
    if (uploadsDirectory) {
        if (!isAbsolute(uploadsDirectory)) {
            errors.push('UPLOADS_DIR must be an absolute path to provider-confirmed persistent storage.');
        } else if (packageDirectory) {
            const packageRoot = resolve(packageDirectory);
            const uploadsPath = resolve(uploadsDirectory);
            const relativePath = relative(packageRoot, uploadsPath);
            if (relativePath === '' || (!relativePath.startsWith(`..${sep}`)
                && relativePath !== '..' && !isAbsolute(relativePath))) {
                errors.push('UPLOADS_DIR must be outside the versioned deployment package directory.');
            }
        }
    }
    if (environment.NODE_ENV && environment.NODE_ENV !== 'production') {
        errors.push('NODE_ENV must be production mode for staging acceptance checks.');
    }
    if (environment.PUBLIC_SITE_URL?.trim() && environment.ADMIN_SITE_URL?.trim()) {
        validStagingOrigins(environment, errors);
    }
    if (environment.DATABASE_URL?.trim() && environment.DATABASE_SSL?.trim()) {
        validDatabaseConfig(environment, errors);
    }
    if (environment.JWT_SECRET?.trim()
        && (environment.JWT_SECRET.length < 64 || /replace-with|change-this/i.test(environment.JWT_SECRET))) {
        errors.push('JWT_SECRET must be a provisioned staging secret of at least 64 characters.');
    }
    if (environment.MFA_ENCRYPTION_KEY?.trim()
        && !/^[a-f0-9]{64}$/i.test(environment.MFA_ENCRYPTION_KEY)) {
        errors.push('MFA_ENCRYPTION_KEY must be a provisioned 64-character hexadecimal key.');
    }
    const pushNames = ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_VAPID_SUBJECT'];
    const configuredPushNames = pushNames.filter((name) => environment[name]?.trim());
    if (configuredPushNames.length > 0 && configuredPushNames.length !== pushNames.length) {
        errors.push('All three WEB_PUSH_VAPID_* values must be configured together or all omitted.');
    }
    return errors;
}

function checkNpmVersion() {
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd --version'] : ['--version'];
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error || result.status !== 0) {
        return { version: null, error: 'npm could not be invoked in this environment.' };
    }
    const version = result.stdout.trim();
    if (parseMajor(version) < minimumNpmMajor) {
        return { version, error: `npm ${minimumNpmMajor} or newer is required by the lockfile format.` };
    }
    return { version, error: null };
}

export async function runStagingPreflight({ packageDirectory, environment = process.env, nodeVersion = process.version, npmVersion } = {}) {
    const errors = [];
    if (!packageDirectory) errors.push('Supply the deployment package directory as the first argument.');
    let packageInfo;
    if (packageDirectory) {
        try {
            packageInfo = await verifyDeploymentPackage(packageDirectory);
        } catch {
            errors.push('Deployment package integrity verification failed; no file contents were displayed.');
        }
    }
    const nodeMajor = parseMajor(nodeVersion);
    if (nodeMajor === null || nodeMajor < minimumNodeMajor) {
        errors.push(`Node.js ${minimumNodeMajor} or newer is required.`);
    }
    const npm = npmVersion === undefined ? checkNpmVersion() : { version: npmVersion, error: null };
    if (npm.error) errors.push(npm.error);
    else if (parseMajor(npm.version) === null || parseMajor(npm.version) < minimumNpmMajor) {
        errors.push(`npm ${minimumNpmMajor} or newer is required by the lockfile format.`);
    }
    errors.push(...validateStagingEnvironment(environment, packageDirectory));

    if (packageDirectory && packageInfo) {
        try {
            const packageJson = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));
            const nodeRequirement = /^\s*>=\s*(\d+)/.exec(String(packageJson.engines?.node || ''));
            if (!nodeRequirement || Number(nodeRequirement[1]) > minimumNodeMajor) {
                errors.push('The deployment package Node.js engine requirement is unsupported by this preflight.');
            }
            const lockfile = JSON.parse(await readFile(resolve(packageDirectory, 'package-lock.json'), 'utf8'));
            if (lockfile.lockfileVersion !== 3) {
                errors.push('The deployment package lockfile is not version 3; verify the compatible npm version.');
            } else if (parseMajor(npm.version) < minimumNpmMajor) {
                errors.push(`npm ${minimumNpmMajor} or newer is required for lockfile version 3.`);
            }
        } catch {
            errors.push('Deployment package runtime metadata could not be read.');
        }
    }
    return {
        errors,
        packageInfo,
        nodeVersion,
        npmVersion: npm.version,
        externalGates
    };
}

async function main(args) {
    if (args.length !== 1) throw new Error('Usage: node scripts/staging-preflight.js <deployment-package-directory>');
    const result = await runStagingPreflight({ packageDirectory: args[0] });
    if (result.errors.length) {
        for (const error of result.errors) console.error(`Preflight failed: ${error}`);
        process.exitCode = 1;
        return;
    }
    console.info(`Local preflight passed: ${result.packageInfo.fileCount} packaged files; Node ${result.nodeVersion}; npm ${result.npmVersion}.`);
    console.info(`Package SHA-256: ${result.packageInfo.packageSha256}`);
    console.info('External staging gates remain NOT VERIFIED; no network, database, or provider checks were performed.');
    for (const gate of result.externalGates) console.info(`NOT VERIFIED: ${gate}`);
    console.info('This local preflight is not deployment authorization or a production-readiness claim.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error) => {
        console.error('Staging preflight failed:', error.message);
        process.exitCode = 1;
    });
}
