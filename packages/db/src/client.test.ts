import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { serializeClientQueries } from './client';

describe('serializeClientQueries', () => {
  it('runs overlapping Promise queries one at a time, in order', async () => {
    const events: string[] = [];
    const gates: Array<() => void> = [];
    const client = fakeClient((...args) => {
      const label = String(args[0]);
      events.push(`start:${label}`);
      return new Promise((resolve) => {
        gates.push(() => {
          events.push(`end:${label}`);
          resolve({ rows: [label] });
        });
      });
    });
    const first = client.query('a');
    await delay(10);
    const second = client.query('b');
    await delay(10);
    expect(events).toEqual(['start:a']);
    const releaseFirst = gates[0];
    if (!releaseFirst) {
      throw new Error('the first query did not start');
    }
    releaseFirst();
    await first;
    await delay(10);
    expect(events).toEqual(['start:a', 'end:a', 'start:b']);
    const releaseSecond = gates[1];
    if (!releaseSecond) {
      throw new Error('the second query did not start');
    }
    releaseSecond();
    await second;
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('passes a callback query through without waiting for the promise queue', () => {
    let callbackRan = false;
    let callbackError: Error | undefined;
    const client = fakeClient((...args) => {
      const last = args[args.length - 1];
      if (isCallback(last)) {
        if (args[0] === null) {
          last(new Error('empty query'));
        } else {
          last(null, { rows: [] });
        }
        return 'callback-return';
      }
      return new Promise(() => undefined);
    });
    const pending = client.query('slow');
    const returned = callbackQuery(client, 'select 1', () => {
      callbackRan = true;
    });
    expect(pending).toBeInstanceOf(Promise);
    expect(returned).toBe('callback-return');
    expect(callbackRan).toBe(true);
    const nullReturned = nullQuery(client, (error) => {
      callbackError = error;
    });
    expect(nullReturned).toBe('callback-return');
    expect(callbackError).toBeInstanceOf(Error);
    expect(callbackError?.message).toBe('empty query');
  });

  it('passes a Submittable through and returns the same object', () => {
    const client = fakeClient((...args) => args[0]);
    const submittable = {
      submit: () => undefined,
    };
    expect(client.query(submittable)).toBe(submittable);
  });

  it('does not let a rejected query block the next one', async () => {
    const client = fakeClient((...args) => {
      const label = String(args[0]);
      if (label === 'bad') {
        return Promise.reject(new Error('bad'));
      }
      return Promise.resolve({ rows: [label] });
    });
    await expect(client.query('bad')).rejects.toThrow('bad');
    await expect(client.query('good')).resolves.toEqual({ rows: ['good'] });
  });
});

type QueryCallback = (error: Error | null, result?: { rows: unknown[] }) => void;

function isCallback(value: unknown): value is QueryCallback {
  return typeof value === 'function';
}

function callbackQuery(client: PoolClient, text: string, callback: () => void): unknown {
  const loose = client as unknown as {
    query(text: string, onResult: () => void): unknown;
  };
  return loose.query(text, callback);
}

function nullQuery(client: PoolClient, callback: (error: Error) => void): unknown {
  const loose = client as unknown as {
    query(text: null, onResult: (error: Error) => void): unknown;
  };
  return loose.query(null, callback);
}

function fakeClient(query: (...args: unknown[]) => unknown): PoolClient {
  const client = { query } as unknown as PoolClient;
  serializeClientQueries(client);
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
