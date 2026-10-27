import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Patch,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Authenticated } from '../authz/authenticated.decorator';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { setXsrfCookie } from './cookies';
import { requestMeta } from './request-meta';
import { SessionService, type CompanySummary } from './session.service';
import { readStaffSession, type StaffSession } from './staff-session';

const localeBody = z
  .object({
    locale: z.enum(['en', 'el']),
  })
  .strict();

type MeResponse = {
  user: {
    id: string;
    email: string;
    displayName: string;
    locale: StaffSession['locale'];
    isPlatformOwner: boolean;
  };
  companies: CompanySummary[];
  session: {
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  };
};

@ApiTags('auth')
@Controller('me')
export class MeController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'The signed-in user, authorised companies and session expiry' })
  @ApiOkResponse({
    description: 'Active memberships, or every active company for a platform owner',
  })
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<MeResponse> {
    const session = readStaffSession(req);
    if (!session) {
      throw new UnauthorizedException('Authentication is required');
    }
    setXsrfCookie(res, this.config, session.sessionId);
    const companies = await this.sessions.authorisedCompanies(session);
    return {
      user: {
        id: session.userId,
        email: session.email,
        displayName: session.displayName,
        locale: session.locale,
        isPlatformOwner: session.isPlatformOwner,
      },
      companies,
      session: {
        idleExpiresAt: session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      },
    };
  }

  @Patch()
  @Authenticated()
  @ApiOperation({ summary: 'Update the signed-in user locale' })
  @ApiOkResponse({
    description: 'The user, authorised companies and session expiry, with the stored locale',
  })
  async updateLocale(@Req() req: Request): Promise<MeResponse> {
    const session = readStaffSession(req);
    if (!session) {
      throw new UnauthorizedException('Authentication is required');
    }
    const parsed = localeBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException('locale must be en or el');
    }
    const locale = await this.sessions.updateLocale(session, parsed.data.locale, requestMeta(req));
    const companies = await this.sessions.authorisedCompanies(session);
    return {
      user: {
        id: session.userId,
        email: session.email,
        displayName: session.displayName,
        locale,
        isPlatformOwner: session.isPlatformOwner,
      },
      companies,
      session: {
        idleExpiresAt: session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      },
    };
  }
}

function unknownBody(req: Request): unknown {
  return req.body as unknown;
}
