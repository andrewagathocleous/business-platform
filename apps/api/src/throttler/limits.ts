/** SPA-friendly default: 300 requests per 60 seconds for one client. */
export const DEFAULT_THROTTLE_LIMIT = 300;
/** `/api/auth/*`: 20 requests per 60 seconds. */
export const AUTH_THROTTLE_LIMIT = 20;
/** `/api/automation/*`: 120 requests per 60 seconds. */
export const AUTOMATION_THROTTLE_LIMIT = 120;
export const DEFAULT_THROTTLE_TTL_MS = 60_000;
