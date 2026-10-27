import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localAgent, Session } from './http';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('localAgent', () => {
  it('fetches through an agent built from a test CA file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bp-milestone-ca-'));
    directories.push(directory);
    const cert = join(directory, 'ca.pem');
    const key = join(directory, 'ca.key');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const server = createServer(
      { cert: readFileSync(cert), key: readFileSync(key) },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const agent = localAgent(cert);
    try {
      const session = new Session(`https://127.0.0.1:${String(address.port)}`, agent);
      const reply = await session.send('GET', '/health');
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ ok: true });
      expect(reply.headers.get('content-type')).toContain('application/json');
    } finally {
      await agent.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
