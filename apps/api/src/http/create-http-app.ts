import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { configureHttp } from './configure-http';
import { caseSensitiveAdapter } from './express-adapter';

export async function createHttpApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, caseSensitiveAdapter(), {
    bodyParser: false,
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  configureHttp(app);
  await app.init();
  return app;
}
