import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The application failed to start';
  console.error(message);
});
