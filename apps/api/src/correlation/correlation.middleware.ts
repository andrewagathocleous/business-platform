import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { correlationStorage, CORRELATION_HEADER, resolveCorrelationId } from './correlation';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.header(CORRELATION_HEADER);
    const correlationId = resolveCorrelationId(header);
    res.setHeader(CORRELATION_HEADER, correlationId);
    correlationStorage.run({ correlationId }, () => {
      next();
    });
  }
}
