import { provideHttpClient, withInterceptors, withXsrfConfiguration } from '@angular/common/http';
import {
  ApplicationConfig,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { firstValueFrom } from 'rxjs';
import { routes } from './app.routes';
import { apiInterceptor } from './core/api.interceptor';
import { SessionStore } from './core/session.store';
import { AppTranslocoLoader } from './i18n/transloco-loader';

/**
 * Default Aura primary and danger buttons are white on emerald.500 and red.500,
 * which are below the 4.5:1 text contrast used on these screens. The darker steps
 * are the same Aura palettes.
 */
const AppAura = definePreset(Aura, {
  components: {
    button: {
      colorScheme: {
        light: {
          root: {
            primary: {
              background: '{emerald.700}',
              hoverBackground: '{emerald.800}',
              activeBackground: '{emerald.900}',
              borderColor: '{emerald.700}',
              hoverBorderColor: '{emerald.800}',
              activeBorderColor: '{emerald.900}',
              color: '#ffffff',
              hoverColor: '#ffffff',
              activeColor: '#ffffff',
            },
            danger: {
              background: '{red.700}',
              hoverBackground: '{red.800}',
              activeBackground: '{red.900}',
              borderColor: '{red.700}',
              hoverBorderColor: '{red.800}',
              activeBorderColor: '{red.900}',
              color: '#ffffff',
              hoverColor: '#ffffff',
              activeColor: '#ffffff',
            },
          },
        },
      },
    },
    paginator: {
      navButton: {
        color: '{surface.700}',
        hoverColor: '{surface.800}',
        selectedColor: '{emerald.800}',
        selectedBackground: '{emerald.50}',
        width: 'auto',
        height: 'auto',
      },
    },
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(
      withXsrfConfiguration({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }),
      withInterceptors([apiInterceptor]),
    ),
    provideTransloco({
      config: {
        availableLangs: ['en', 'el'],
        defaultLang: 'en',
        fallbackLang: 'en',
        missingHandler: { useFallbackTranslation: true },
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
      },
      loader: AppTranslocoLoader,
    }),
    providePrimeNG({
      theme: {
        preset: AppAura,
        options: {
          darkModeSelector: 'none',
        },
      },
    }),
    MessageService,
    provideAppInitializer(() => {
      const session = inject(SessionStore);
      const transloco = inject(TranslocoService);
      return firstValueFrom(transloco.load('en')).then(() => session.load());
    }),
  ],
};
