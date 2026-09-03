import type { CoexistenceConnection, EmbeddedSignupSetup } from '@/types';

/** Pinned to what the server talks; the SDK refuses a version it has retired. */
const GRAPH_VERSION = 'v26.0';
const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** The slice of Meta's SDK this file uses. Not the whole surface, on purpose. */
interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string }; status?: string }) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: { setup: Record<string, never>; featureType: string; sessionInfoVersion: string };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FacebookSdk> | null = null;

/** Loads Meta's SDK once. A second call while the first is in flight shares the promise. */
function loadSdk(appId: string): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  if (loading) return loading;
  loading = new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      loading = null;
      reject(new Error('Не удалось загрузить скрипт Meta. Проверьте блокировщик рекламы.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Runs Meta's Embedded Signup for a number that lives in the WhatsApp Business app.
 *
 * Meta answers on two channels: the login callback carries the `code`, and a `message`
 * event from facebook.com carries the session data (WABA id, sometimes the phone number id).
 * Both are needed, in either order; the promise settles once both are in. The code lives
 * thirty seconds, so the caller must post it to the server immediately.
 */
export function runCoexistenceSignup(setup: EmbeddedSignupSetup): Promise<CoexistenceConnection> {
  return loadSdk(setup.appId).then(
    (fb) =>
      new Promise<CoexistenceConnection>((resolve, reject) => {
        let code: string | null = null;
        let session: Omit<CoexistenceConnection, 'code'> | null = null;

        const settle = () => {
          if (code && session) {
            window.removeEventListener('message', onMessage);
            resolve({ code, ...session });
          }
        };

        const onMessage = (event: MessageEvent) => {
          if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return;
          let data: {
            type?: string;
            event?: string;
            data?: {
              waba_id?: string;
              phone_number_id?: string;
              business_id?: string;
              error_message?: string;
            };
          };
          try {
            data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          } catch {
            return;
          }
          if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;

          if (data.event === 'CANCEL' || data.event === 'ERROR') {
            window.removeEventListener('message', onMessage);
            reject(new Error(data.data?.error_message ?? 'Подключение отменено'));
            return;
          }
          if (data.data?.waba_id) {
            session = {
              wabaId: data.data.waba_id,
              phoneNumberId: data.data.phone_number_id,
              businessId: data.data.business_id,
            };
            settle();
          }
        };
        window.addEventListener('message', onMessage);

        fb.login(
          (response) => {
            if (response.authResponse?.code) {
              code = response.authResponse.code;
              settle();
            } else if (!session) {
              window.removeEventListener('message', onMessage);
              reject(new Error('Meta не вернула код подтверждения'));
            }
          },
          {
            config_id: setup.configId,
            response_type: 'code',
            override_default_response_type: true,
            extras: {
              setup: {},
              featureType: 'whatsapp_business_app_onboarding',
              sessionInfoVersion: '3',
            },
          },
        );
      }),
  );
}
