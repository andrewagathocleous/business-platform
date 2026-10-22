import { HttpContextToken } from '@angular/common/http';

/**
 * Set on the request that is the primary load of a page (lists, detail, company context).
 * A 403 or 404 on that request navigates. Other company GETs toast only.
 */
export const NAVIGATE_ON_DENIED = new HttpContextToken<boolean>(() => false);
