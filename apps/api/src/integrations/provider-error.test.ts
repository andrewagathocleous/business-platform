import {
  BlockedDestination,
  ConnectFailure,
  DnsFailure,
  PrestashopAuthFailed,
  PrestashopBadResponse,
  PrintNodeHttpError,
  ProviderRejected,
  RequestUncertain,
  ResponseTooLarge,
  TooManyRedirects,
  UnexpectedRedirect,
} from '@bp/integrations';
import { describe, expect, it } from 'vitest';
import { providerErrorClass } from './provider-error';

describe('providerErrorClass', () => {
  it('maps shop and transport failures to one class', () => {
    expect(providerErrorClass(new PrestashopAuthFailed())).toBe('auth_failed');
    expect(providerErrorClass(new PrestashopBadResponse(404))).toBe('not_found');
    expect(providerErrorClass(new PrestashopBadResponse(200))).toBe('bad_response');
    expect(providerErrorClass(new PrestashopBadResponse(500))).toBe('bad_response');
    expect(providerErrorClass(new BlockedDestination('GET', 'https://10.0.0.1', '/api/orders'))).toBe(
      'blocked_destination',
    );
    expect(providerErrorClass(new DnsFailure('GET', 'https://shop.example.test', '/api/orders'))).toBe(
      'unreachable',
    );
    expect(providerErrorClass(new ConnectFailure('GET', 'https://shop.example.test', '/api/orders'))).toBe(
      'unreachable',
    );
    expect(providerErrorClass(new RequestUncertain('GET', 'https://shop.example.test', '/api/orders'))).toBe(
      'timeout',
    );
    expect(providerErrorClass(new ResponseTooLarge('GET', 'https://shop.example.test', '/api/orders'))).toBe(
      'bad_response',
    );
    expect(providerErrorClass(new TooManyRedirects('GET', 'https://shop.example.test', '/api/orders'))).toBe(
      'bad_response',
    );
    expect(providerErrorClass(new UnexpectedRedirect('GET', 'https://shop.example.test', '/api/orders'))).toBe(
      'bad_response',
    );
    expect(providerErrorClass(new PrintNodeHttpError(401))).toBe('auth_failed');
    expect(providerErrorClass(new PrintNodeHttpError(403))).toBe('auth_failed');
    expect(providerErrorClass(new PrintNodeHttpError(404))).toBe('not_found');
    expect(providerErrorClass(new PrintNodeHttpError(500))).toBe('bad_response');
    expect(providerErrorClass(new ProviderRejected('auth_failed'))).toBe('auth_failed');
    expect(providerErrorClass(new ProviderRejected('provider_unreachable'))).toBe('provider_unreachable');
    expect(providerErrorClass(new ProviderRejected('bad_response'))).toBe('bad_response');
    expect(providerErrorClass(new Error('secret-body'))).toBe('bad_response');
  });
});
