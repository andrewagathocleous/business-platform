import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '../config/env';

export function swaggerConfig() {
  return new DocumentBuilder()
    .setTitle('Business Platform API')
    .setDescription('Staff and automation HTTP API.')
    .setVersion('0.0.0')
    .build();
}

export function mountSwagger(app: INestApplication, config: AppConfig): void {
  if (config.appEnv !== 'development' && config.appEnv !== 'test') {
    return;
  }
  const document = SwaggerModule.createDocument(app, swaggerConfig());
  SwaggerModule.setup('docs', app, document, { useGlobalPrefix: true });
}
