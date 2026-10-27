import { SetMetadata } from '@nestjs/common';

export const PLATFORM_OWNER_KEY = 'bp:platform-owner';

/**
 * Staff session plus platform-owner capability. This is not a permission.
 * When privileged MFA is required, a session with `mfa_satisfied = false` is denied.
 */
export const PlatformOwner = (): ClassDecorator & MethodDecorator => SetMetadata(PLATFORM_OWNER_KEY, true);
