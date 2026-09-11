import { ApiError } from '../errors.js';
import { decryptSecret } from '../secret-box.js';
import { asCloudNumber, type WhatsappNumberRow } from './cloud-number.js';
import { GraphError, withoutSecret, type GraphClient } from './graph.js';
import { LinkedOffline, type LinkedClient, type OutgoingFile } from './linked/client.js';

/**
 * How a message leaves, decided by the number it leaves through.
 *
 * Two call sites — an operator's reply and the agent's — used to know how to talk to Meta.
 * They now ask the number for a transport and say what to send, which is what lets a third
 * way of reaching WhatsApp exist without either of them learning about it.
 */

export interface MessageTransport {
  sendText(to: string, body: string): Promise<{ messageId: string }>;
  sendMedia(to: string, file: OutgoingFile): Promise<{ messageId: string }>;
  /**
   * Whether the 24-hour rule applies.
   *
   * It is Meta's rule, not WhatsApp's: outside 24 hours from the customer's last message
   * the Cloud API accepts only a template. A linked device is an ordinary WhatsApp client
   * and has no such window, so enforcing it there would refuse sends that would have gone
   * through — a bug that reads as a policy.
   */
  readonly requiresOpenWindow: boolean;
}

/**
 * A refusal with a sentence the operator can act on.
 *
 * An `ApiError` so the routes need no translation layer, and a subclass so the turn — which
 * answers in prose rather than in status codes — can still tell «the transport said no»
 * from any other failure.
 */
export class TransportRefusal extends ApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'TransportRefusal';
  }
}

export interface TransportDeps {
  graph: GraphClient;
  linked: LinkedClient;
  /** The credentials key, for a Cloud API number's stored token. */
  key: Buffer;
}

/** WhatsApp addresses one person by jid; the cabinet stores digits. */
export const jidFor = (phone: string): string => `${phone}@s.whatsapp.net`;

function cloudTransport(number: WhatsappNumberRow, deps: TransportDeps): MessageTransport {
  const cloud = asCloudNumber(number);

  // Decrypted once, here, so a key that no longer opens the token fails before anything is
  // sent rather than halfway through a reply. The English message the crypto throws is not
  // for an operator; this one is.
  let token: string;
  try {
    token = decryptSecret(cloud.accessToken, deps.key, cloud.phoneNumberId);
  } catch {
    throw new TransportRefusal(
      409,
      'Не удалось прочитать токен номера. Подключите номер заново в интеграциях.',
    );
  }

  const send = async <T>(attempt: () => Promise<T>): Promise<T> => {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof GraphError) {
        throw new TransportRefusal(
          502,
          `Meta не отправила сообщение: ${withoutSecret(error.message, token)}`,
        );
      }
      throw error;
    }
  };

  return {
    requiresOpenWindow: true,
    sendText: (to, body) => send(() => deps.graph.sendText(cloud.phoneNumberId, token, to, body)),
    sendMedia: () => {
      throw new TransportRefusal(
        501,
        'Отправка файлов пока работает только для номера, подключённого по QR.',
      );
    },
  };
}

function linkedTransport(number: WhatsappNumberRow, deps: TransportDeps): MessageTransport {
  const refusal = (): TransportRefusal =>
    number.linkedState === 'logged_out'
      ? new TransportRefusal(409, 'Телефон отвязал кабинет. Нужно подключить заново по QR.')
      : new TransportRefusal(
          409,
          'Телефон не на связи. Откройте WhatsApp на телефоне или подключите заново.',
        );

  const send = async <T>(attempt: () => Promise<T>): Promise<T> => {
    try {
      return await attempt();
    } catch (error) {
      // Nothing was sent: the socket is not there. Every other failure is the library's
      // and is reported as it is, because we do not know what it means.
      if (error instanceof LinkedOffline) throw refusal();
      throw error;
    }
  };

  return {
    requiresOpenWindow: false,
    sendText: (to, body) => send(() => deps.linked.sendText(number.id, jidFor(to), body)),
    sendMedia: (to, file) => send(() => deps.linked.sendMedia(number.id, jidFor(to), file)),
  };
}

export function transportFor(
  number: WhatsappNumberRow,
  deps: TransportDeps,
): MessageTransport {
  return number.connectionKind === 'linked'
    ? linkedTransport(number, deps)
    : cloudTransport(number, deps);
}
