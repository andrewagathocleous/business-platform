import { Controller, Get, Module } from '@nestjs/common';
import { DiscoveryModule, MetadataScanner, NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AutomationRoute } from '../automation/automation-route.decorator';
import { Authenticated } from './authenticated.decorator';
import { Public } from './public.decorator';
import { RequirePermission } from './require-permission.decorator';
import { RoutePolicyChecker } from './route-policy';

@Controller('bare')
class BareController {
  @Get()
  bare(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [BareController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class BareModule {}

@Controller('ok')
@Public()
class PublicController {
  @Get()
  ok(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [PublicController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class PublicModule {}

@Controller('session')
class SessionController {
  @Get()
  @Authenticated()
  me(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [SessionController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class SessionModule {}

@Controller('conflict')
@Public()
class ConflictController {
  @Get()
  @RequirePermission('member.manage')
  secret(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [ConflictController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class ConflictModule {}

@Controller('both')
class BothController {
  @Get()
  @Public()
  @RequirePermission('member.manage')
  secret(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [BothController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class BothModule {}

@Controller('automation/v1')
class UnmarkedAutomationController {
  @Get()
  @Public()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [UnmarkedAutomationController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class UnmarkedAutomationModule {}

@Controller('c/:companyId')
@AutomationRoute()
class MarkedStaffController {
  @Get()
  @Public()
  open(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [MarkedStaffController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class MarkedStaffModule {}

@Controller('automation/v1')
@AutomationRoute()
class MarkedAutomationController {
  @Get()
  @Public()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [MarkedAutomationController],
  providers: [MetadataScanner, RoutePolicyChecker],
})
class MarkedAutomationModule {}

describe('route self-check', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('fails boot for a controller with neither decorator', async () => {
    app = await NestFactory.create(BareModule, { abortOnError: false, logger: false });
    await expect(app.init()).rejects.toThrow(/Route self-check failed/);
  });

  it('boots a controller marked @Public()', async () => {
    app = await NestFactory.create(PublicModule, { abortOnError: false, logger: false });
    await app.init();
  });

  it('boots a controller marked @Authenticated()', async () => {
    app = await NestFactory.create(SessionModule, { abortOnError: false, logger: false });
    await app.init();
  });

  it('fails boot when a class is @Public() and a method requires a permission', async () => {
    app = await NestFactory.create(ConflictModule, { abortOnError: false, logger: false });
    await expect(app.init()).rejects.toThrow(
      /Route self-check failed[\s\S]*public and permission: ConflictController\.secret/,
    );
  });

  it('fails boot when an automation controller has no @AutomationRoute()', async () => {
    app = await NestFactory.create(UnmarkedAutomationModule, { abortOnError: false, logger: false });
    await expect(app.init()).rejects.toThrow(/automation route missing @AutomationRoute\(\): UnmarkedAutomationController/);
  });

  it('fails boot when @AutomationRoute() is outside /api/automation', async () => {
    app = await NestFactory.create(MarkedStaffModule, { abortOnError: false, logger: false });
    await expect(app.init()).rejects.toThrow(/@AutomationRoute\(\) outside \/api\/automation: MarkedStaffController/);
  });

  it('boots an automation controller that is marked and under /api/automation', async () => {
    app = await NestFactory.create(MarkedAutomationModule, { abortOnError: false, logger: false });
    await app.init();
  });

  it('fails boot when one method is both public and a permission', async () => {
    app = await NestFactory.create(BothModule, { abortOnError: false, logger: false });
    await expect(app.init()).rejects.toThrow(/public and permission: BothController\.secret/);
  });
});
