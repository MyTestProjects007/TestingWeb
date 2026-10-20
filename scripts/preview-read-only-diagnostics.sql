\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

SELECT CASE WHEN current_database() = 'shopademia_browser_preview'
                 AND inet_server_addr() = '127.0.0.1'::inet
                 AND inet_server_port() = 55441
            THEN 'true' ELSE 'false' END AS target_identity_ok
\gset

\if :target_identity_ok
\echo 'Target identity gate passed: shopademia_browser_preview at 127.0.0.1:55441.'
\else
\echo 'STOP: target identity did not match. No catalog diagnostics will run.'
ROLLBACK;
\quit 3
\endif

\echo 'Connection identity and current-session role attributes:'
SELECT current_database() AS database_name,
       current_user AS current_role,
       inet_server_addr() AS server_address,
       inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('search_path') AS configured_search_path,
       current_schemas(false) AS effective_schemas,
       role.rolsuper AS is_superuser,
       role.rolinherit AS inherits_memberships,
       role.rolcreatedb AS can_create_database,
       role.rolcreaterole AS can_create_role,
       role.rolreplication AS can_replicate,
       role.rolbypassrls AS can_bypass_row_security
FROM pg_roles AS role
WHERE role.rolname = current_user;

\echo 'Target database owner, effective database privileges, and ACL entries:'
SELECT db.datname AS database_name,
       pg_get_userbyid(db.datdba) AS database_owner,
       candidate.rolname AS candidate_runtime_role,
       privilege.privilege_type,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_database_privilege(candidate.oid, db.oid, privilege.privilege_type)
       END AS effective_for_candidate,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS acl_grantee,
       acl.privilege_type AS acl_privilege,
       acl.is_grantable
FROM pg_database AS db
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
CROSS JOIN (VALUES ('CONNECT'), ('CREATE'), ('TEMPORARY')) AS privilege(privilege_type)
LEFT JOIN LATERAL aclexplode(
    COALESCE(db.datacl, acldefault('d', db.datdba))
) AS acl ON true
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE db.datname = current_database()
  AND (acl.privilege_type IS NULL OR acl.privilege_type = privilege.privilege_type)
ORDER BY privilege.privilege_type, acl_grantee;

\echo 'Candidate runtime role attributes:'
SELECT role.rolname,
       role.rolcanlogin AS can_login,
       role.rolsuper AS is_superuser,
       role.rolinherit AS inherits_memberships,
       role.rolcreatedb AS can_create_database,
       role.rolcreaterole AS can_create_role,
       role.rolreplication AS can_replicate,
       role.rolbypassrls AS can_bypass_row_security,
       has_database_privilege(role.oid, current_database(), 'CONNECT') AS can_connect,
       has_database_privilege(role.oid, current_database(), 'CREATE') AS can_create_in_database,
       has_database_privilege(role.oid, current_database(), 'TEMP') AS can_create_temp_objects
FROM pg_roles AS role
WHERE role.rolname = 'shopademia_preview_ro';

\echo 'Direct memberships granted to the candidate runtime role:'
SELECT member.rolname AS member_role,
       granted.rolname AS granted_role,
       grantor.rolname AS grantor_role,
       membership.admin_option,
       membership.inherit_option,
       membership.set_option
FROM pg_auth_members AS membership
JOIN pg_roles AS member ON member.oid = membership.member
JOIN pg_roles AS granted ON granted.oid = membership.roleid
JOIN pg_roles AS grantor ON grantor.oid = membership.grantor
WHERE member.rolname = 'shopademia_preview_ro'
ORDER BY granted.rolname;

\echo 'Direct and transitive membership roles available to candidate:'
SELECT granted.rolname AS reachable_role,
       pg_has_role(candidate.oid, granted.oid, 'MEMBER') AS is_member,
       pg_has_role(candidate.oid, granted.oid, 'USAGE') AS privileges_inherited
FROM pg_roles AS candidate
CROSS JOIN pg_roles AS granted
WHERE candidate.rolname = 'shopademia_preview_ro'
  AND candidate.oid <> granted.oid
  AND pg_has_role(candidate.oid, granted.oid, 'MEMBER')
ORDER BY granted.rolname;

\echo 'Candidate role/database search_path and read-only setting overrides:'
SELECT role.rolname,
       CASE WHEN settings.setrole = 0 THEN '(all roles)'
            ELSE role.rolname END AS role_scope,
       CASE WHEN settings.setdatabase = 0 THEN '(all databases)'
            ELSE db.datname END AS database_scope,
       setting.value AS setting
FROM pg_db_role_setting AS settings
LEFT JOIN pg_roles AS role ON role.oid = settings.setrole
LEFT JOIN pg_database AS db ON db.oid = settings.setdatabase
CROSS JOIN LATERAL unnest(settings.setconfig) AS setting(value)
WHERE (settings.setrole = 0 OR role.rolname = 'shopademia_preview_ro')
  AND (settings.setdatabase = 0 OR db.datname = current_database())
  AND (setting.value LIKE 'search_path=%'
       OR setting.value LIKE 'default_transaction_read_only=%')
ORDER BY role_scope, database_scope, setting.value;

\echo 'Schema owners, ACLs, and candidate effective USAGE/CREATE:'
SELECT namespace.nspname AS schema_name,
       pg_get_userbyid(namespace.nspowner) AS schema_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS acl_grantee,
       acl.privilege_type,
       acl.is_grantable,
       candidate.rolname AS candidate_runtime_role,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_schema_privilege(candidate.oid, namespace.oid, 'USAGE') END AS effective_usage,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_schema_privilege(candidate.oid, namespace.oid, 'CREATE') END AS effective_create
FROM pg_namespace AS namespace
CROSS JOIN LATERAL aclexplode(
    COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
ORDER BY namespace.nspname, acl_grantee, acl.privilege_type;

\echo 'Non-system relation owners, raw ACL entries, and effective relation privileges:'
SELECT namespace.nspname AS schema_name,
       relation.relname AS relation_name,
       relation.relkind AS relation_kind,
       pg_get_userbyid(relation.relowner) AS relation_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS acl_grantee,
       acl.privilege_type AS acl_privilege,
       acl.is_grantable,
       privilege.privilege_type AS checked_privilege,
       candidate.rolname AS candidate_runtime_role,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_table_privilege(candidate.oid, relation.oid, privilege.privilege_type)
       END AS effective_for_candidate
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
CROSS JOIN (VALUES
    ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
    ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
) AS privilege(privilege_type)
CROSS JOIN LATERAL aclexplode(
    COALESCE(relation.relacl, acldefault('r', relation.relowner))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY relation.relname, privilege.privilege_type, acl_grantee;

\echo 'Explicit column ACLs and candidate effective column privileges:'
SELECT relation.relname AS relation_name,
       attribute.attname AS column_name,
       pg_get_userbyid(relation.relowner) AS relation_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS acl_grantee,
       acl.privilege_type AS acl_privilege,
       acl.is_grantable,
       privilege.privilege_type AS checked_privilege,
       candidate.rolname AS candidate_runtime_role,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_column_privilege(
                candidate.oid, relation.oid, attribute.attnum, privilege.privilege_type
            )
       END AS effective_for_candidate
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))
    AS privilege(privilege_type)
LEFT JOIN LATERAL aclexplode(attribute.attacl) AS acl ON true
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND (
      attribute.attacl IS NOT NULL
      OR candidate.oid IS NOT NULL
  )
ORDER BY relation.relname, attribute.attname, privilege.privilege_type, acl_grantee;

\echo 'Non-system sequence owners, ACL entries, and effective candidate privileges:'
SELECT sequence.relname AS sequence_name,
       pg_get_userbyid(sequence.relowner) AS sequence_owner,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS acl_grantee,
       acl.privilege_type AS acl_privilege,
       acl.is_grantable,
       privilege.privilege_type AS checked_privilege,
       candidate.rolname AS candidate_runtime_role,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_sequence_privilege(candidate.oid, sequence.oid, privilege.privilege_type)
       END AS effective_for_candidate
FROM pg_class AS sequence
JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
CROSS JOIN (VALUES ('SELECT'), ('USAGE'), ('UPDATE')) AS privilege(privilege_type)
CROSS JOIN LATERAL aclexplode(
    COALESCE(sequence.relacl, acldefault('S', sequence.relowner))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
  AND sequence.relkind = 'S'
ORDER BY sequence.relname, privilege.privilege_type, acl_grantee;

\echo 'Non-system routine owners, SECURITY DEFINER status, ACL entries, effective EXECUTE:'
SELECT routine.oid::regprocedure AS routine_name,
       pg_get_userbyid(routine.proowner) AS routine_owner,
       routine.prosecdef AS is_security_definer,
       routine.prokind AS routine_kind,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS acl_grantee,
       acl.privilege_type AS acl_privilege,
       acl.is_grantable,
       candidate.rolname AS candidate_runtime_role,
       CASE WHEN candidate.oid IS NULL THEN NULL
            ELSE has_function_privilege(candidate.oid, routine.oid, 'EXECUTE')
       END AS effective_execute
FROM pg_proc AS routine
JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
CROSS JOIN LATERAL aclexplode(
    COALESCE(routine.proacl, acldefault('f', routine.proowner))
) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
LEFT JOIN pg_roles AS candidate ON candidate.rolname = 'shopademia_preview_ro'
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
ORDER BY routine_name, acl_grantee;

\echo 'Existing non-system object ownership inventory:'
SELECT 'relation' AS object_kind,
       format('%I.%I', namespace.nspname, relation.relname) AS object_name,
       relation.relkind::text AS object_type,
       pg_get_userbyid(relation.relowner) AS owner
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
UNION ALL
SELECT 'routine', routine.oid::regprocedure::text, 'routine',
       pg_get_userbyid(routine.proowner)
FROM pg_proc AS routine
JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
UNION ALL
SELECT 'type', format('%I.%I', namespace.nspname, object_type.typname), 'type',
       pg_get_userbyid(object_type.typowner)
FROM pg_type AS object_type
JOIN pg_namespace AS namespace ON namespace.oid = object_type.typnamespace
WHERE namespace.nspname !~ '^pg_'
  AND namespace.nspname <> 'information_schema'
ORDER BY object_kind, object_name;

\echo 'Existing default ACLs, by object-creating role (global and non-system schemas):'
SELECT pg_get_userbyid(default_acl.defaclrole) AS object_creator_role,
       COALESCE(namespace.nspname, '(all schemas)') AS schema_scope,
       default_acl.defaclobjtype AS object_type_code,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE grantee.rolname END AS grantee,
       acl.privilege_type,
       acl.is_grantable
FROM pg_default_acl AS default_acl
LEFT JOIN pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
WHERE default_acl.defaclnamespace = 0
   OR (
       namespace.nspname !~ '^pg_'
       AND namespace.nspname <> 'information_schema'
   )
ORDER BY object_creator_role, schema_scope, object_type_code, grantee, acl.privilege_type;

ROLLBACK;
\echo 'Diagnostics finished. Read-only transaction rolled back; no DDL or DML was permitted.'
