import 'reflect-metadata';
import { loadRootEnv } from './config/load-env';
import { loadConfig } from './config/env';
import { createHttpApp } from './http/create-http-app';

export async function bootstrap(): Promise<void> {
  loadRootEnv();
  const config = loadConfig(process.env);
  const app = await createHttpApp();
  // Nest otherwise re-raises SIGTERM, which the parent sees as a signal death rather than exit 0.
  app.enableShutdownHooks(undefined, { useProcessExit: true });
  await app.listen(config.port, config.host);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('main.ts') || entry.endsWith('main.js')) {
  bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
