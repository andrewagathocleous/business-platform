import type { Grant } from '@bp/domain';

/**
 * Privileged permissions are removed when the request context is built.
 * `CompanyAccessService` applies this on every company request so a mid-session
 * promotion cannot use these until the user signs in again with MFA.
 *
 * Entra v2 `amr` / `acrs` behaviour is still to verify (U2). `mfa` is matched
 * case-sensitively and is not assumed when the claim is absent.
 */
export const PRIVILEGED_PERMISSIONS = [
  'member.invite',
  'member.manage',
  'member.sessions.revoke',
  'role.manage',
  'company.bank.manage',
  'automation.manage',
  'service_identity.manage',
  'store.manage',
  'integration.manage',
] as const;

const PRIVILEGED = new Set<string>(PRIVILEGED_PERMISSIONS);

export function mfaSatisfiedFromAmr(amr: unknown): boolean {
  if (typeof amr === 'string') {
    return amr === 'mfa';
  }
  if (!Array.isArray(amr)) {
    return false;
  }
  return amr.some((item) => item === 'mfa');
}

export type MfaPolicyInput = {
  grants: readonly Grant[];
  isPlatformOwner: boolean;
  mfaSatisfied: boolean;
  requireMfaForPrivileged: boolean;
};

export type MfaPolicyResult = {
  grants: Grant[];
  isPlatformOwner: boolean;
  mfaStepUpRequired: boolean;
  withheldPermissions: string[];
};

export function applyMfaPolicy(input: MfaPolicyInput): MfaPolicyResult {
  if (!input.requireMfaForPrivileged || input.mfaSatisfied) {
    return {
      grants: input.grants.map((grant) => ({ ...grant })),
      isPlatformOwner: input.isPlatformOwner,
      mfaStepUpRequired: false,
      withheldPermissions: [],
    };
  }
  const withheld = new Set<string>();
  const grants = input.grants.filter((grant) => {
    if (!PRIVILEGED.has(grant.permission)) {
      return true;
    }
    withheld.add(grant.permission);
    return false;
  });
  if (input.isPlatformOwner) {
    withheld.add('platform-owner');
  }
  return {
    grants,
    isPlatformOwner: false,
    mfaStepUpRequired: withheld.size > 0,
    withheldPermissions: [...withheld],
  };
}
