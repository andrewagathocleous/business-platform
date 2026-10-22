import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env';
import { apiSecurityHeaders } from './configure-http';

describe('api security headers', () => {
  it('sends HSTS only when APP_ENV is uat or production', async () => {
    for (const appEnv of ['development', 'test'] as const) {
      const ready = await request(appFor(appEnv)).get('/api/health/ready');
      expect(ready.headers['strict-transport-security']).toBeUndefined();
      const docs = await request(appFor(appEnv)).get('/api/docs');
      expect(docs.headers['strict-transport-security']).toBeUndefined();
    }
    for (const appEnv of ['uat', 'production'] as const) {
      const ready = await request(appFor(appEnv)).get('/api/health/ready');
      expect(ready.headers['strict-transport-security']).toMatch(/max-age=/);
      const docs = await request(appFor(appEnv)).get('/api/docs');
      expect(docs.headers['strict-transport-security']).toMatch(/max-age=/);
    }
  });
});

function appFor(appEnv: AppEnv): express.Express {
  const app = express();
  app.use(apiSecurityHeaders({ appEnv }));
  app.get('/api/health/ready', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/api/docs', (_req, res) => {
    res.type('html').send('docs');
  });
  return app;
}
