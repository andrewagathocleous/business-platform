-- Idempotent roles and databases for local dev, CI and the VPS.
-- Passwords and bp_owner_createdb are psql variables:
--   psql -v bp_owner_password=... -v bp_app_password=... -v n8n_password=... -v bp_owner_createdb=on|off -f roles.sql
-- bp_owner_createdb=on is for local `prisma migrate dev` (shadow database). CI and production pass off.

\set ON_ERROR_STOP on

-- psql does not substitute :'variables' inside dollar quotes, so the DO block is
-- assembled outside them and executed with \gexec.
SELECT format($sql$
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bp_owner') THEN
    CREATE ROLE bp_owner LOGIN PASSWORD %L;
  ELSE
    ALTER ROLE bp_owner WITH LOGIN PASSWORD %L;
  END IF;
  ALTER ROLE bp_owner NOSUPERUSER NOBYPASSRLS NOCREATEROLE;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bp_app') THEN
    CREATE ROLE bp_app LOGIN PASSWORD %L;
  ELSE
    ALTER ROLE bp_app WITH LOGIN PASSWORD %L;
  END IF;
  ALTER ROLE bp_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n') THEN
    CREATE ROLE n8n LOGIN PASSWORD %L;
  ELSE
    ALTER ROLE n8n WITH LOGIN PASSWORD %L;
  END IF;
  ALTER ROLE n8n NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
END
$do$;
$sql$,
  :'bp_owner_password', :'bp_owner_password',
  :'bp_app_password', :'bp_app_password',
  :'n8n_password', :'n8n_password')\gexec

SELECT CASE
  WHEN :'bp_owner_createdb' = 'on' THEN 'ALTER ROLE bp_owner CREATEDB'
  ELSE 'ALTER ROLE bp_owner NOCREATEDB'
END\gexec

SELECT format('CREATE DATABASE business_platform OWNER bp_owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'business_platform')\gexec

SELECT format('CREATE DATABASE business_platform_test OWNER bp_owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'business_platform_test')\gexec

SELECT format('CREATE DATABASE n8n OWNER n8n')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'n8n')\gexec

ALTER DATABASE business_platform OWNER TO bp_owner;
ALTER DATABASE business_platform_test OWNER TO bp_owner;
ALTER DATABASE n8n OWNER TO n8n;

REVOKE ALL ON DATABASE business_platform FROM PUBLIC;
REVOKE ALL ON DATABASE business_platform_test FROM PUBLIC;
REVOKE ALL ON DATABASE n8n FROM PUBLIC;

GRANT CONNECT ON DATABASE business_platform TO bp_owner;
GRANT CONNECT ON DATABASE business_platform TO bp_app;
GRANT CONNECT ON DATABASE business_platform_test TO bp_owner;
GRANT CONNECT ON DATABASE business_platform_test TO bp_app;
GRANT CONNECT ON DATABASE n8n TO n8n;

\connect business_platform
GRANT USAGE ON SCHEMA public TO bp_app;
GRANT USAGE, CREATE ON SCHEMA public TO bp_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE bp_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bp_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bp_app;

\connect business_platform_test
GRANT USAGE ON SCHEMA public TO bp_app;
GRANT USAGE, CREATE ON SCHEMA public TO bp_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE bp_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bp_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bp_app;
