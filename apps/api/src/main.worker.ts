import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './config/env';
import { loadRootEnv } from './config/load-env';

/**
 * Nest application context only. There is no HTTP listener.
 * The job loop is Step C.
 */
export async function bootstrapWorker(): Promise<void> {
  loadRootEnv();
  loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logger.log('worker ready');
  // A signal listener does not keep the event loop alive.
  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await app.close();
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('main.worker.ts') || entry.endsWith('main.worker.js')) {
  bootstrapWorker()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
