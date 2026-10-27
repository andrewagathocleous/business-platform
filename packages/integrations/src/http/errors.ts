/**
 * Transport failures for the safe outbound client.
 * `sent` means the request may have reached the server. Callers retry only when it is false.
 * Messages use the method, origin and pathname. They never include header values, bodies,
 * query strings or URL userinfo.
 */
export class SafeFetchError extends Error {
  readonly code: string;
  readonly sent: boolean;

  constructor(code: string, sent: boolean, method: string, origin: string, pathname: string) {
    super(`${code} ${method} ${origin}${pathname}`);
    this.name = new.target.name;
    this.code = code;
    this.sent = sent;
  }
}

export class BlockedDestination extends SafeFetchError {
  override readonly name = 'BlockedDestination';

  constructor(method: string, origin: string, pathname: string) {
    super('blocked_destination', false, method, origin, pathname);
  }
}

export class DnsFailure extends SafeFetchError {
  override readonly name = 'DnsFailure';

  constructor(method: string, origin: string, pathname: string) {
    super('dns_failure', false, method, origin, pathname);
  }
}

export class ConnectFailure extends SafeFetchError {
  override readonly name = 'ConnectFailure';

  constructor(method: string, origin: string, pathname: string) {
    super('connect_failure', false, method, origin, pathname);
  }
}

export class RequestUncertain extends SafeFetchError {
  override readonly name = 'RequestUncertain';

  constructor(method: string, origin: string, pathname: string) {
    super('request_uncertain', true, method, origin, pathname);
  }
}

export class ResponseTooLarge extends SafeFetchError {
  override readonly name = 'ResponseTooLarge';

  constructor(method: string, origin: string, pathname: string) {
    super('response_too_large', true, method, origin, pathname);
  }
}

export class TooManyRedirects extends SafeFetchError {
  override readonly name = 'TooManyRedirects';

  constructor(method: string, origin: string, pathname: string) {
    super('too_many_redirects', true, method, origin, pathname);
  }
}

export class UnexpectedRedirect extends SafeFetchError {
  override readonly name = 'UnexpectedRedirect';

  constructor(method: string, origin: string, pathname: string) {
    super('unexpected_redirect', true, method, origin, pathname);
  }
}
