import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Authenticated } from '../authz/authenticated.decorator';
import { Public } from '../authz/public.decorator';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { CORRELATION_HEADER, getCorrelationId, uuidv7 } from '../correlation/correlation';
import { errorBody } from '../http/error-body';
import {
  clearOidcFlowCookie,
  clearSessionCookie,
  clearXsrfCookie,
  readSessionCookie,
  setOidcFlowCookie,
  setSessionCookie,
  setXsrfCookie,
} from './cookies';
import { publicAuthProviders, oidcConfigured } from './auth-providers';
import { DevLoginService, devLoginEnabled } from './dev-login.service';
import { OidcService } from './oidc.service';
import { relativeRedirect, containsControlCharacter } from './redirect';
import { requestMeta } from './request-meta';
import { SessionService } from './session.service';
import { readStaffSession } from './staff-session';

const loginBody = z.object({
  email: z.string().trim().min(3).max(320),
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DevLoginService) private readonly devLogin: DevLoginService,
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get('providers')
  @Public()
  @ApiOperation({ summary: 'Which sign-in methods are enabled. The response contains no secrets.' })
  @ApiOkResponse({ description: 'Development login and OIDC availability' })
  providers(): { devLogin: boolean; oidc: boolean } {
    return publicAuthProviders(this.config);
  }

  @Get('dev/users')
  @Public()
  @ApiOperation({ summary: 'Fictional users for the development login picker' })
  @ApiOkResponse({ description: 'Seed users with a membership summary' })
  async devUsers(): Promise<{ users: Awaited<ReturnType<DevLoginService['listUsers']>> }> {
    if (!devLoginEnabled(this.config)) {
      throw new NotFoundException();
    }
    return { users: await this.devLogin.listUsers() };
  }

  @Post('dev/login')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Development login by fictional email' })
  async devLoginRoute(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    user: { id: string; email: string; displayName: string; isPlatformOwner: boolean };
    session: { idleExpiresAt: string; absoluteExpiresAt: string };
  }> {
    if (!devLoginEnabled(this.config)) {
      throw new NotFoundException();
    }
    const parsed = loginBody.safeParse(unknownBody(req));
    if (!parsed.success || !parsed.data.email.includes('@')) {
      throw new BadRequestException('email is required');
    }
    const result = await this.devLogin.login(
      parsed.data.email,
      requestMeta(req),
      readSessionCookie(req, this.config),
    );
    if (!result.ok) {
      throw new UnauthorizedException('Authentication failed');
    }
    setSessionCookie(res, this.config, result.token);
    setXsrfCookie(res, this.config, result.sessionId);
    return { user: result.user, session: result.session };
  }

  @Get('oidc/start')
  @Public()
  @ApiOperation({ summary: 'Start the Entra authorization-code flow' })
  async oidcStart(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!oidcConfigured(this.config)) {
      throw new NotFoundException();
    }
    const redirect = redirectInput(req.query['redirect']);
    if (!redirect.ok) {
      throw new BadRequestException('redirect must be a relative path');
    }
    const invitation = invitationInput(req.query['invitation']);
    if (!invitation.ok) {
      throw new BadRequestException('invitation is invalid');
    }
    try {
      const started = await this.oidc.start(redirect.path, invitation.token);
      setOidcFlowCookie(res, this.config, started.flowCookie);
      res.redirect(302, started.authorizationUrl);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.warn(`OIDC start failed: ${errorName(error)}`);
      throw new InternalServerErrorException('Sign-in is unavailable');
    }
  }

  @Get('oidc/callback')
  @Public()
  @ApiOperation({ summary: 'Complete the Entra authorization-code flow' })
  async oidcCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    clearOidcFlowCookie(res, this.config);
    if (!oidcConfigured(this.config)) {
      sendError(res, 404, 'Not found');
      return;
    }
    try {
      const result = await this.oidc.callback(
        req,
        requestMeta(req),
        readSessionCookie(req, this.config),
      );
      if (!result.ok) {
        sendError(res, result.status, result.message);
        return;
      }
      setSessionCookie(res, this.config, result.token);
      setXsrfCookie(res, this.config, result.sessionId);
      res.redirect(302, result.redirectTo);
    } catch (error) {
      this.logger.warn(`OIDC callback failed: ${errorName(error)}`);
      sendError(res, 500, 'Internal server error');
    }
  }

  @Post('logout')
  @Authenticated()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the staff session and clear its cookies' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const session = readStaffSession(req);
    if (!session) {
      throw new UnauthorizedException('Authentication is required');
    }
    await this.sessions.revoke(session, requestMeta(req));
    clearSessionCookie(res, this.config);
    clearXsrfCookie(res, this.config);
  }
}

function unknownBody(req: Request): unknown {
  return req.body as unknown;
}

function redirectInput(value: unknown): { ok: true; path: string } | { ok: false } {
  if (value === undefined) {
    return { ok: true, path: '/' };
  }
  if (typeof value !== 'string') {
    return { ok: false };
  }
  const path = relativeRedirect(value);
  if (!path) {
    return { ok: false };
  }
  return { ok: true, path };
}

function invitationInput(value: unknown): { ok: true; token: string | null } | { ok: false } {
  if (value === undefined) {
    return { ok: true, token: null };
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    containsControlCharacter(value)
  ) {
    return { ok: false };
  }
  return { ok: true, token: value };
}

function sendError(res: Response, status: number, message: string): void {
  const correlationId = getCorrelationId() ?? uuidv7();
  res.setHeader(CORRELATION_HEADER, correlationId);
  const rendered = errorBody(new HttpException(message, status), correlationId);
  res.status(rendered.status).json(rendered.body);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
