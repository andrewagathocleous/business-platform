import { createPrismaClient } from '@bp/db';
import { runOwnerCli } from './owner-commands';

/**
 * Entry point: `node dist/cli/owner.js <command>`.
 * Run through the `owner-cli` compose service, which has only `DATABASE_URL_OWNER`.
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_OWNER'];
  if (!url) {
    process.stderr.write('DATABASE_URL_OWNER is required\n');
    process.exitCode = 2;
    return;
  }
  const prisma = createPrismaClient(url);
  try {
    process.exitCode = await runOwnerCli(process.argv.slice(2), prisma, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    await prisma.$disconnect();
  }
}

void main();
