export class DatabaseSslConfigurationError extends Error {
    constructor() {
        super('DATABASE_SSL must be set to true, false, 1, or 0.');
        this.name = 'DatabaseSslConfigurationError';
    }
}

export function parseDatabaseSsl(value) {
    const setting = String(value ?? '').trim().toLowerCase();
    if (!['', 'true', 'false', '1', '0'].includes(setting)) {
        throw new DatabaseSslConfigurationError();
    }
    return setting === 'true' || setting === '1';
}
