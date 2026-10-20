import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SwaggerModule } from '@nestjs/swagger';
import { loadConfig } from './config/env';
import { loadRootEnv } from './config/load-env';
import { createHttpApp } from './http/create-http-app';
import { swaggerConfig } from './openapi/swagger';

export async function exportOpenApi(): Promise<void> {
  loadRootEnv();
  loadConfig(process.env);
  const app = await createHttpApp();
  try {
    const document = SwaggerModule.createDocument(app, swaggerConfig());
    const target = resolve(__dirname, '../../../docs/api/openapi.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('export-openapi.ts') || entry.endsWith('export-openapi.js')) {
  exportOpenApi().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
