import type { CoexistenceConnection, EmbeddedSignupSetup, InstagramSetup } from '@/types';

/** Pinned to what the server talks; the SDK refuses a version it has retired. */
const GRAPH_VERSION = 'v26.0';
const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** Origins Meta's signup window posts from: https, any facebook.com subdomain, nothing else. */
const FACEBOOK_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*facebook\.com$/;

/** The slice of Meta's SDK this file uses. Not the whole surface, on purpose. */
interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string }; status?: string }) => void,
    options:
      | {
          config_id: string;
          response_type: 'code';
          override_default_response_type: true;
          extras: { setup: Record<string, never>; featureType: string; sessionInfoVersion: string };
        }
      | { scope: string; response_type: 'code'; override_default_response_type: true },
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

        /**
         * Meta answers on two channels and may answer on neither: a window closed by hand
         * fires no CANCEL, and the promise would then never settle, leaving the button on
         * «Ждём Meta…» for the rest of the session. Five minutes is far longer than the flow
         * takes and far shorter than the patience of whoever is watching.
         */
        const timer = window.setTimeout(
          () => fail('Meta не ответила. Закройте окно Meta и попробуйте снова.'),
          5 * 60 * 1000,
        );

        const settle = () => {
          if (code && session) {
            window.clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve({ code, ...session });
          }
        };

        /** Every failure path leaves through here, so the listener is never left behind. */
        const fail = (message: string) => {
          window.clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          reject(new Error(message));
        };

        const onMessage = (event: MessageEvent) => {
          // Meta posts from www., web. and business. subdomains, so the subdomain is open —
          // but the scheme and the registrable domain are not: a suffix test would also
          // admit https://evilfacebook.com and plain http.
          if (!FACEBOOK_ORIGIN.test(event.origin)) return;
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
            fail(data.data?.error_message ?? 'Подключение отменено');
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
            } else {
              // Unconditionally, not only when the session is still missing: without a code
              // the promise can never settle, and a session that arrived first would
              // otherwise leave the button stuck on «Ждём Meta…» forever.
              fail('Meta не вернула код подтверждения');
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

/**
 * Разрешения, которых хватает ровно на чтение постов и ничего сверх.
 *
 * `instagram_basic` is the captions; the two page permissions are how Meta gets from the
 * person logging in to the Instagram account attached to their Page, which is the only way
 * an Instagram Business account is addressable at all.
 */
const INSTAGRAM_SCOPE = 'instagram_basic,pages_show_list,pages_read_engagement';

/**
 * Вход через Meta ради постов Instagram: возвращает код, который живёт секунды.
 *
 * Nothing is stored in the browser and nothing is stored on the server: the code is spent
 * once, the posts are read once, and importing again is this window again. An owner who
 * removes the application in Meta has actually removed our access, with nothing of theirs
 * left behind here.
 */
export function runInstagramLogin(setup: InstagramSetup): Promise<string> {
  return loadSdk(setup.appId).then(
    (fb) =>
      new Promise<string>((resolve, reject) => {
        fb.login(
          (response) => {
            if (response.authResponse?.code) {
              resolve(response.authResponse.code);
              return;
            }
            reject(new Error('Вход через Meta не завершён'));
          },
          {
            scope: INSTAGRAM_SCOPE,
            response_type: 'code',
            override_default_response_type: true,
          },
        );
      }),
  );
}
