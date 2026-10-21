import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loggerParams } from './logging.module';
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS, redactLoggedRequest } from './redact';

describe('log redaction', () => {
  it('redacts cookie and authorization headers', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const spy = vi.spyOn(stream, 'write');
    const logger = pino(
      { redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR } },
      stream,
    );
    logger.info({
      req: {
        headers: {
          cookie: 'session=super-secret-cookie-value',
          authorization: 'Bearer super-secret-authorization-value',
        },
      },
      token: 'super-secret-token-value',
    });
    expect(spy).toHaveBeenCalled();
    const output = lines.join('');
    expect(output).not.toContain('super-secret-cookie-value');
    expect(output).not.toContain('super-secret-authorization-value');
    expect(output).not.toContain('super-secret-token-value');
    expect(output).toContain(LOG_REDACT_CENSOR);
  });

  it('redacts invitation tokens, OIDC query values and the location header', () => {
    const sentinel = 'fictional-sentinel-token';
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const spy = vi.spyOn(stream, 'write');
    const params = loggerParams(stream).pinoHttp;
    const logger = pino({ redact: params.redact, serializers: { req: redactLoggedRequest } }, stream);
    const url = `/api/auth/oidc/callback?code=${sentinel}&state=${sentinel}&invitation=${sentinel}&session_state=${sentinel}&id_token=${sentinel}&token=${sentinel}&access_token=${sentinel}&keep=visible`;
    logger.info({
      req: {
        method: 'GET',
        url,
        originalUrl: url,
        query: {
          code: sentinel,
          state: sentinel,
          invitation: sentinel,
          session_state: sentinel,
          id_token: sentinel,
          token: sentinel,
          access_token: sentinel,
          keep: 'visible',
        },
        headers: {},
      },
      res: { headers: { location: `https://app.example.test/cb?code=${sentinel}` } },
    });
    expect(spy).toHaveBeenCalled();
    const output = lines.join('');
    expect(output).not.toContain(sentinel);
    expect(output).toContain(LOG_REDACT_CENSOR);
    expect(output).toContain('visible');
  });

  it('redacts token headers and the referer query', () => {
    const sentinel = 'fictional-header-secret';
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const spy = vi.spyOn(stream, 'write');
    const logger = pino({ serializers: { req: redactLoggedRequest } }, stream);
    logger.info({
      req: {
        method: 'GET',
        url: '/api/auth/oidc/callback',
        headers: {
          'x-xsrf-token': sentinel,
          'x-api-key': sentinel,
          referer: `https://app.example.test/join?invitation=${sentinel}&keep=visible-referer`,
          accept: 'application/json',
        },
      },
    });
    expect(spy).toHaveBeenCalled();
    const output = lines.join('');
    expect(output).not.toContain(sentinel);
    expect(output).toContain(LOG_REDACT_CENSOR);
    expect(output).toContain('visible-referer');
    expect(output).toContain('application/json');
  });
});
