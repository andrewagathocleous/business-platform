import pg from 'pg';

// Same database ACL as infra/postgres/roles.sql, applied after CREATE DATABASE.
// A new database grants CONNECT to PUBLIC, which would include n8n.

export async function applyAppDatabaseAcl({ host, port, user, password, database }) {
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing to change privileges on unexpected database name "${database}"`);
  }
  const ident = pg.escapeIdentifier(database);
  const admin = new pg.Client({
    host,
    port,
    user,
    password,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`REVOKE ALL ON DATABASE ${ident} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident} TO bp_owner`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident} TO bp_app`);
  } finally {
    await admin.end();
  }

  const target = new pg.Client({ host, port, user, password, database });
  await target.connect();
  try {
    await target.query('GRANT USAGE ON SCHEMA public TO bp_app');
    await target.query('GRANT USAGE, CREATE ON SCHEMA public TO bp_owner');
    await target.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE bp_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bp_app',
    );
    await target.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE bp_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bp_app',
    );
  } finally {
    await target.end();
  }
}
