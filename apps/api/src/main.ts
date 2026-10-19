/**
 * STUB (Step A): HTTP entrypoint.
 * Step B replaces this with config validation, middleware and the HTTP listener.
 * Running the file exits with an error so the stub is not a silent success.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export const API_HTTP_ENTRYPOINT = 'stub' as const;

export function bootstrap(): Promise<void> {
  return Promise.reject(
    new Error(
      `apps/api HTTP entrypoint is a Step A stub. Step B calls ${NestFactory.create.name}(${AppModule.name}).`,
    ),
  );
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('main.ts') || entry.endsWith('main.js')) {
  console.error('apps/api HTTP entrypoint is a Step A stub. Step B implements startup.');
  process.exitCode = 1;
}
