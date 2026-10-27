import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS, redactLoggedRequest } from './redact';

export const LOG_STREAM = Symbol('LOG_STREAM');

export function loggerParams(stream: DestinationStream) {
  return {
    pinoHttp: {
      stream,
      redact: {
        paths: [...LOG_REDACT_PATHS],
        censor: LOG_REDACT_CENSOR,
      },
      serializers: {
        req: redactLoggedRequest,
      },
    },
  };
}

@Module({
  providers: [{ provide: LOG_STREAM, useValue: process.stdout satisfies DestinationStream }],
  exports: [LOG_STREAM],
})
export class LogStreamModule {}

@Module({
  imports: [
    LogStreamModule,
    LoggerModule.forRootAsync({
      imports: [LogStreamModule],
      inject: [LOG_STREAM],
      useFactory: (stream: DestinationStream) => loggerParams(stream),
    }),
  ],
})
export class LoggingModule {}
