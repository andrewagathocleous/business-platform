import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../../.env') });

// `prisma generate` does not connect. Migrate commands fail closed if the real URL is missing.
const url =
  process.env['DATABASE_URL_OWNER'] ??
  'postgresql://bp_owner:placeholder@127.0.0.1:5432/business_platform';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url,
  },
});
