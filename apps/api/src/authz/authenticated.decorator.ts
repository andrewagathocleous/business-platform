import { SetMetadata } from '@nestjs/common';

export const AUTHENTICATED_KEY = 'bp:authenticated';

/**
 * The caller must have a staff session. No company permission is required.
 * Permission checks are Step B-3. Use this for routes such as `/api/me` and logout.
 * A handler must not combine this with `@Public()` or `@RequirePermission()`.
 */
export const Authenticated = (): ClassDecorator & MethodDecorator => SetMetadata(AUTHENTICATED_KEY, true);
