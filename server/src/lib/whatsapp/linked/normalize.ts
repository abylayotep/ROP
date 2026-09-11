import type { RawLinkedContent, RawLinkedMessage, Timestamp } from './client.js';

/**
 * One Baileys message, reduced to the line the store writes.
 *
 * Everything this file decides is a decision about what the cabinet is for: it shows a
 * seller their customers' one-to-one chats. Groups, status broadcasts and the protocol
 * traffic WhatsApp uses to keep devices in step are not that, and are dropped here rather
 * than filtered out further down where each consumer would have to remember to do it.
 */

export interface NormalizedLine {
  waMessageId: string;
  /** Digits only, the shape `contacts.phone` uses. */
  from: string;
  fromMe: boolean;
  sentAt: Date;
  kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'unsupported';
  body: string | null;
  /** The sender's own name, when their phone offered one. */
  pushName: string | null;
  /** True when the message carries a file worth downloading. */
  hasMedia: boolean;
}

/**
 * `77085807932:12@s.whatsapp.net` → `77085807932`. A group or a broadcast answers null.
 *
 * The `:12` is the sender's device, which changes when they pick up a different handset and
 * has nothing to do with who they are.
 */
export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, domain] = jid.split('@');
  if (domain !== 's.whatsapp.net') return null;
  const digits = (user ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
  return digits.length > 0 ? digits : null;
}

/** Seconds, as a number or as protobuf's Long. */
function toDate(timestamp: Timestamp): Date {
  const seconds =
    typeof timestamp === 'number'
      ? timestamp
      : typeof timestamp === 'object' && timestamp !== null
        ? timestamp.toNumber()
        : 0;
  return new Date(seconds * 1000);
}

interface Content {
  kind: NormalizedLine['kind'];
  body: string | null;
  hasMedia: boolean;
}

/**
 * Keyed on which sub-object is present, the way WhatsApp populates exactly one of them.
 *
 * A caption counts as the message's text: a photo of a stamp with «такой размер?» under it
 * is one question, and dropping the caption would leave the agent answering a blank image.
 */
function contentOf(message: RawLinkedContent): Content {
  if (typeof message.conversation === 'string') {
    return { kind: 'text', body: message.conversation, hasMedia: false };
  }
  if (message.extendedTextMessage) {
    return { kind: 'text', body: message.extendedTextMessage.text ?? null, hasMedia: false };
  }
  if (message.imageMessage) {
    return { kind: 'image', body: message.imageMessage.caption ?? null, hasMedia: true };
  }
  if (message.videoMessage) {
    return { kind: 'video', body: message.videoMessage.caption ?? null, hasMedia: true };
  }
  if (message.audioMessage) {
    return { kind: 'audio', body: null, hasMedia: true };
  }
  if (message.documentMessage) {
    return { kind: 'document', body: message.documentMessage.caption ?? null, hasMedia: true };
  }
  if (message.stickerMessage) {
    return { kind: 'sticker', body: null, hasMedia: true };
  }
  // A location, a contact card, a poll, a list reply. The thread reads correctly with a row
  // saying something arrived; pretending it was text would put an empty line in the chat.
  return { kind: 'unsupported', body: null, hasMedia: false };
}

/**
 * Null for everything the cabinet does not store.
 *
 * - a group (`@g.us`) or a status broadcast: not a customer conversation;
 * - a protocol or reaction message: WhatsApp talking to itself, or an emoji on someone
 *   else's line, neither of which is a message in a thread;
 * - no id, or no content at all: nothing to deduplicate on and nothing to show.
 */
export function normalize(raw: RawLinkedMessage): NormalizedLine | null {
  const waMessageId = raw.key?.id ?? null;
  const from = jidToPhone(raw.key?.remoteJid);
  if (!waMessageId || !from) return null;

  const message = raw.message;
  if (!message) return null;
  if (message.protocolMessage || message.reactionMessage) return null;

  const content = contentOf(message);
  return {
    waMessageId,
    from,
    fromMe: raw.key?.fromMe === true,
    sentAt: toDate(raw.messageTimestamp),
    kind: content.kind,
    body: content.body,
    pushName: raw.pushName ?? null,
    hasMedia: content.hasMedia,
  };
}

/** The mime type a message's file carries, when it carries one. */
export function mimeOf(raw: RawLinkedMessage): string | null {
  const message = raw.message;
  if (!message) return null;
  return (
    message.imageMessage?.mimetype ??
    message.videoMessage?.mimetype ??
    message.audioMessage?.mimetype ??
    message.documentMessage?.mimetype ??
    message.stickerMessage?.mimetype ??
    null
  );
}
