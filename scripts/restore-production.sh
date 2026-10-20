#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
    printf 'Usage: %s <database.dump.age> <uploads.tar.gz.age> <age-identity> <new-restore-directory>\n' "$0" >&2
    exit 2
fi

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESTORE_ENV_FILE="${RESTORE_ENV_FILE:-}"
STAGING_ENV_FILE="$ROOT_DIR/.env.staging"
COMPOSE_FILE="$ROOT_DIR/docker-compose.staging.yml"
database_backup="$1"
uploads_backup="$2"
age_identity="$3"
restore_directory="$4"

if [[ -z "$RESTORE_ENV_FILE" ]]; then
    printf 'RESTORE_ENV_FILE must name an authorized isolated staging environment; production defaults are not allowed.\n' >&2
    exit 1
fi
if [[ ! -f "$RESTORE_ENV_FILE" || -L "$RESTORE_ENV_FILE" ]]; then
    printf 'Restore environment must be a regular, non-symlink file: %s\n' "$RESTORE_ENV_FILE" >&2
    exit 1
fi
if [[ "$RESTORE_ENV_FILE" != "$STAGING_ENV_FILE" ]]; then
    printf 'Restore environment must be the project .env.staging file validated by the staging safety checks.\n' >&2
    exit 1
fi
if [[ ! -f "$COMPOSE_FILE" || -L "$COMPOSE_FILE" ]]; then
    printf 'Isolated staging Compose file is missing or is not a regular file: %s\n' "$COMPOSE_FILE" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    printf 'Node.js is required to validate the staging restore environment.\n' >&2
    exit 1
fi
if ! (cd "$ROOT_DIR" && node scripts/validate-staging-config.js); then
    printf 'Staging restore environment failed the project safety validator.\n' >&2
    exit 1
fi

for file in "$database_backup" "$uploads_backup" "$age_identity"; do
    if [[ ! -f "$file" ]]; then
        printf 'Required file not found: %s\n' "$file" >&2
        exit 1
    fi
done
if [[ -e "$restore_directory" ]]; then
    printf 'Restore directory already exists; choose a new empty path: %s\n' "$restore_directory" >&2
    exit 1
fi
for command_name in age docker tar; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        printf '%s is required to restore production backups.\n' "$command_name" >&2
        exit 1
    fi
done

if [[ -n "${DOCKER_HOST:-}" || -n "${DOCKER_CONTEXT:-}" ]]; then
    printf 'Refusing Docker overrides; unset DOCKER_HOST and DOCKER_CONTEXT and use the local default context.\n' >&2
    exit 1
fi
docker_context="$(docker context show)"
if [[ "$docker_context" != "default" ]]; then
    printf 'Refusing non-default Docker context: %s\n' "$docker_context" >&2
    exit 1
fi
docker_endpoint="$(docker context inspect default --format '{{ (index .Endpoints "docker").Host }}')"
if [[ "$docker_endpoint" != unix://* && "$docker_endpoint" != npipe://* ]]; then
    printf 'Refusing non-local Docker endpoint.\n' >&2
    exit 1
fi

umask 077
mkdir -m 700 -- "$restore_directory"
staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/shopademia-restore.XXXXXX")"
restore_database="shopademia_restore_$(date -u +%Y%m%d%H%M%S)_$$"
database_created=false
restore_complete=false
cleanup() {
    rm -rf -- "$staging_directory"
    if [[ "$database_created" == true && "$restore_complete" != true ]]; then
        docker compose --project-name shopademia-restore --env-file "$RESTORE_ENV_FILE" -f "$COMPOSE_FILE" exec -T database \
            sh -ec 'dropdb --if-exists --username="$POSTGRES_USER" "$1"' restore "$restore_database" >&2 || true
        rmdir -- "$restore_directory" 2>/dev/null || true
    fi
}
trap cleanup EXIT

age --decrypt --identity "$age_identity" --output "$staging_directory/database.dump" "$database_backup"
age --decrypt --identity "$age_identity" --output "$staging_directory/uploads.tar.gz" "$uploads_backup"

while IFS= read -r entry; do
    if [[ "$entry" == uploads/ ]] || [[ "$entry" =~ ^uploads/[0-9a-fA-F-]{36}\.(jpg|png|webp)$ ]]; then
        continue
    fi
    printf 'Refusing unexpected path in uploads archive: %s\n' "$entry" >&2
    exit 1
done < <(tar --list --gzip --file "$staging_directory/uploads.tar.gz")
if tar --list --verbose --gzip --file "$staging_directory/uploads.tar.gz" | grep -Eq '^[lh]'; then
    printf 'Refusing links in uploads backup archive.\n' >&2
    exit 1
fi

docker compose --project-name shopademia-restore --env-file "$RESTORE_ENV_FILE" -f "$COMPOSE_FILE" exec -T database \
    sh -ec 'createdb --username="$POSTGRES_USER" "$1"' restore "$restore_database"
database_created=true
docker compose --project-name shopademia-restore --env-file "$RESTORE_ENV_FILE" -f "$COMPOSE_FILE" exec -T database \
    sh -ec 'pg_restore --exit-on-error --no-owner --username="$POSTGRES_USER" --dbname="$1"' restore "$restore_database" \
    < "$staging_directory/database.dump"
tar --extract --gzip --file "$staging_directory/uploads.tar.gz" --directory "$restore_directory" \
    --no-same-owner --no-same-permissions
restore_complete=true

printf 'Database restored to isolated database: %s\n' "$restore_database"
printf 'Uploaded files restored under: %s/uploads\n' "$restore_directory"
printf 'This script does not replace production data or copy files into the live uploads volume.\n'
