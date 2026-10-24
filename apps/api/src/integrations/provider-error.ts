import {
  PrestashopAuthFailed,
  PrestashopBadResponse,
  PrintNodeHttpError,
  ProviderRejected,
  SafeFetchError,
} from '@bp/integrations';

/**
 * One map from a shop or PrintNode failure to the class a settings response may carry.
 * The class is a short name. It is never a body, a header or a URL.
 */
export function providerErrorClass(error: unknown): string {
  if (error instanceof PrestashopAuthFailed) {
    return 'auth_failed';
  }
  if (error instanceof PrestashopBadResponse) {
    return error.status === 404 ? 'not_found' : 'bad_response';
  }
  if (error instanceof PrintNodeHttpError) {
    if (error.status === 401 || error.status === 403) {
      return 'auth_failed';
    }
    return error.status === 404 ? 'not_found' : 'bad_response';
  }
  if (error instanceof ProviderRejected) {
    if (
      error.message === 'auth_failed' ||
      error.message === 'provider_unreachable' ||
      error.message === 'bad_response'
    ) {
      return error.message;
    }
    return 'bad_response';
  }
  if (error instanceof SafeFetchError) {
    switch (error.code) {
      case 'blocked_destination':
        return 'blocked_destination';
      case 'dns_failure':
      case 'connect_failure':
        return 'unreachable';
      case 'request_uncertain':
        return 'timeout';
      case 'response_too_large':
      case 'too_many_redirects':
      case 'unexpected_redirect':
        return 'bad_response';
      default:
        return 'bad_response';
    }
  }
  return 'bad_response';
}
