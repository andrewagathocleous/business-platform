import type { AppConfig } from '../config/env';
import { devLoginEnabled } from './dev-login.service';

/** True only when every OIDC setting is present. The values themselves are never returned. */
export function oidcConfigured(config: AppConfig): boolean {
  return (
    config.oidcIssuer.length > 0 &&
    config.oidcClientId.length > 0 &&
    config.oidcClientSecret.length > 0 &&
    config.oidcRedirectUri.length > 0
  );
}

/** Public sign-in flags. This object must stay free of secrets and configuration values. */
export function publicAuthProviders(config: AppConfig): { devLogin: boolean; oidc: boolean } {
  return {
    devLogin: devLoginEnabled(config),
    oidc: oidcConfigured(config),
  };
}
