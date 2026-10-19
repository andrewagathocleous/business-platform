/**
 * STUB (Step A): worker entrypoint.
 * Step B runs the job loop in a Nest application context with no HTTP listener.
 * Running the file exits with an error so the stub is not a silent success.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export const API_WORKER_ENTRYPOINT = 'stub' as const;

export function bootstrapWorker(): Promise<void> {
  return Promise.reject(
    new Error(
      `apps/api worker entrypoint is a Step A stub. Step B calls ${NestFactory.createApplicationContext.name}(${AppModule.name}).`,
    ),
  );
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('main.worker.ts') || entry.endsWith('main.worker.js')) {
  console.error('apps/api worker entrypoint is a Step A stub. Step B implements the job loop.');
  process.exitCode = 1;
}
