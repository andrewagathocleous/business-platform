import { Controller, Get, type INestApplication, type Type } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { SessionService } from '../identity/session.service';
import type { StaffAuth } from '../identity/staff-session';
import { AutomationRoute } from '../automation/automation-route.decorator';
import { AuthorizationGuard } from './authorization.guard';
import { CompanyAccessService } from './company-access.service';
import { Public } from './public.decorator';
import { RequirePermission } from './require-permission.decorator';
import { ServiceIdentityAuthenticator } from './service-identity-auth';

@Controller('mixed')
@Public()
class MixedController {
  @Get()
  @RequirePermission('member.manage')
  secret(): { ok: true } {
    return { ok: true };
  }

  @Get('open')
  @Public()
  open(): { ok: true } {
    return { ok: true };
  }
}

@Controller('staff')
class StaffController {
  @Get()
  @RequirePermission('member.view')
  hidden(): { ok: true } {
    return { ok: true };
  }
}

@Controller('automation/v1/c/:companyId')
@AutomationRoute()
class AutomationController {
  @Get('ping')
  @RequirePermission('store.events.ingest')
  ping(): { ok: true } {
    return { ok: true };
  }
}

function config(): AppConfig {
  return {
    appEnv: 'test',
    authDevLoginEnabled: false,
    sessionCookieSecure: false,
    csrfSecret: 'csrf-secret',
    authRequireMfaForPrivileged: false,
    oidcIssuer: '',
    oidcClientId: '',
    oidcClientSecret: '',
    oidcRedirectUri: '',
    masterKeys: {},
    activeMasterKeyId: 'k1',
    databaseUrl: 'postgresql://bp_app:pw@127.0.0.1:5432/business_platform_test',
    port: 3000,
    host: '127.0.0.1',
    throttleDefaultLimit: 300,
    throttleAuthLimit: 20,
    throttleAutomationLimit: 120,
    throttleEnabledInTest: false,
    storageRoot: '/tmp/bp-storage',
    mockPrintRoot: '/tmp/bp-mock-print',
  };
}

async function boot(
  controller: Type,
  fromRequest: (...args: never[]) => Promise<StaffAuth>,
  recordDenial: (...args: never[]) => Promise<void>,
  prefix = false,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
    providers: [
      Reflector,
      { provide: APP_GUARD, useClass: AuthorizationGuard },
      { provide: AuditService, useValue: { recordDenial } },
      { provide: SessionService, useValue: { fromRequest } },
      { provide: APP_CONFIG, useValue: config() },
      { provide: ServiceIdentityAuthenticator, useValue: { authenticate: vi.fn(), touch: vi.fn() } },
      {
        provide: CompanyAccessService,
        useValue: { enforce: vi.fn(() => Promise.resolve()), enforcePlatformOwner: vi.fn(() => Promise.resolve()) },
      },
      { provide: PrismaService, useValue: { client: { company: { findUnique: vi.fn() } } } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ abortOnError: false, logger: false });
  if (prefix) {
    app.setGlobalPrefix('api');
  }
  await app.init();
  return app;
}

function httpServer(application: INestApplication): App {
  return application.getHttpServer() as App;
}

describe('AuthorizationGuard', () => {
  it('does not treat a @RequirePermission method on a @Public class as public', async () => {
    const recordDenial = vi.fn(() => Promise.resolve());
    const fromRequest = vi.fn(
      (): Promise<StaffAuth> => Promise.resolve({ ok: false, reason: 'missing', userId: null, sessionId: null }),
    );
    const app = await boot(MixedController, fromRequest, recordDenial);
    try {
      const denied = await request(httpServer(app)).get('/mixed');
      expect(denied.status).toBe(401);
      expect(denied.body).not.toEqual({ ok: true });
      expect(fromRequest).toHaveBeenCalled();
      expect(recordDenial).toHaveBeenCalled();

      const open = await request(httpServer(app)).get('/mixed/open');
      expect(open.status).toBe(200);
      expect(open.body).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('rejects a bearer token on a staff route before accepting a session', async () => {
    const denials: { action: string; details: { reason: string } }[] = [];
    const recordDenial = vi.fn((input: { action: string; details: { reason: string } }) => {
      denials.push(input);
      return Promise.resolve();
    });
    const fromRequest = vi.fn(
      (): Promise<StaffAuth> => Promise.reject(new Error('session must not be accepted when a bearer token is present')),
    );
    const app = await boot(StaffController, fromRequest, recordDenial);
    try {
      const response = await request(httpServer(app)).get('/staff').set('Authorization', 'Bearer bps_secret');
      expect(response.status).toBe(401);
      expect(response.body).not.toEqual({ ok: true });
      expect(fromRequest).not.toHaveBeenCalled();
      expect(denials[0]?.action).toBe('authorization.denied');
      expect(denials[0]?.details.reason).toBe('bearer_on_staff_route');
    } finally {
      await app.close();
    }
  });

  it('rejects a session cookie on an automation route before reading the session', async () => {
    const denials: { action: string; details: { reason: string } }[] = [];
    const recordDenial = vi.fn((input: { action: string; details: { reason: string } }) => {
      denials.push(input);
      return Promise.resolve();
    });
    const fromRequest = vi.fn(
      (): Promise<StaffAuth> => Promise.reject(new Error('session cookie must not authenticate an automation route')),
    );
    const app = await boot(AutomationController, fromRequest, recordDenial, true);
    try {
      const url = '/api/automation/v1/c/11111111-1111-4111-8111-111111111111/ping';
      const withoutXsrf = await request(httpServer(app)).get(url).set('Cookie', 'bp_session=staff-cookie');
      const withXsrf = await request(httpServer(app))
        .get(url)
        .set('Cookie', 'bp_session=staff-cookie')
        .set('X-XSRF-TOKEN', 'token');
      expect(withoutXsrf.status).toBe(401);
      expect(withXsrf.status).toBe(401);
      expect(fromRequest).not.toHaveBeenCalled();
      expect(denials.map((denial) => denial.details.reason)).toEqual([
        'automation_requires_bearer',
        'automation_requires_bearer',
      ]);
    } finally {
      await app.close();
    }
  });
});
