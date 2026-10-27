import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { CORRELATION_HEADER, getCorrelationId, uuidv7 } from '../correlation/correlation';
import { errorBody } from './error-body';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      return;
    }
    const correlationId = getCorrelationId() ?? headerValue(response.getHeader(CORRELATION_HEADER)) ?? uuidv7();
    response.setHeader(CORRELATION_HEADER, correlationId);
    const rendered = errorBody(exception, correlationId);
    response.status(rendered.status).json(rendered.body);
  }
}

function headerValue(value: number | string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}
