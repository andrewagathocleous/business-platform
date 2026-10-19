import { describe, expect, it } from 'vitest';
import { API_HTTP_ENTRYPOINT } from './main';
import { API_WORKER_ENTRYPOINT } from './main.worker';

describe('api entrypoints', () => {
  it('marks both Step A entrypoints as stubs', () => {
    expect(API_HTTP_ENTRYPOINT).toBe('stub');
    expect(API_WORKER_ENTRYPOINT).toBe('stub');
  });
});
