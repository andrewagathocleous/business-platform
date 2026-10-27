import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { JobRunner } from './automation/jobs/job-runner';
import { AppModule } from './app.module';
import { loadConfig } from './config/env';
import { loadRootEnv } from './config/load-env';

/**
 * Nest application context only. There is no HTTP listener.
 * The job loop keeps the process alive until SIGTERM or SIGINT.
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
  const jobs = app.get(JobRunner);
  jobs.startLoop();
  logger.log('worker ready');
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      logger.log(`received ${signal}`);
      jobs
        .stop()
        .then(() => app.close())
        .then(() => {
          resolve();
        })
        .catch((error: unknown) => {
          reject(error instanceof Error ? error : new Error('worker shutdown failed'));
        });
    };
    process.on('SIGTERM', () => {
      stop('SIGTERM');
    });
    process.on('SIGINT', () => {
      stop('SIGINT');
    });
  });
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
