import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GraphClient } from './graph.js';

/**
 * Fetching a file a client sent.
 *
 * WhatsApp hands over an id, not bytes. The URL behind it lives for minutes and the file for
 * thirty days, so it is fetched when the message arrives rather than when someone opens the
 * conversation — otherwise scrolling back a month shows a broken image.
 */

/** Comfortably above WhatsApp's own limit for every type it accepts. */
const MAX_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
};

/**
 * The extension for a mime type, ignoring parameters — WhatsApp sends voice notes as
 * `audio/ogg; codecs=opus`, and the part after the semicolon is not part of the type.
 */
export function extensionFor(mime: string): string {
  return EXTENSIONS[mime.split(';')[0]!.trim().toLowerCase()] ?? '.bin';
}

export interface DownloadParams {
  mediaId: string;
  /** Already decrypted. This function does no key handling. */
  token: string;
  agentId: string;
  waMessageId: string;
}

export async function downloadInboundMedia(
  deps: { graph: GraphClient; mediaDir: string },
  params: DownloadParams,
): Promise<{ path: string; mime: string }> {
  const descriptor = await deps.graph.getMediaUrl(params.mediaId, params.token);

  if (descriptor.fileSize > MAX_BYTES) {
    throw new Error(`Media ${params.mediaId} is ${descriptor.fileSize} bytes, over the limit`);
  }

  const bytes = await deps.graph.downloadMedia(descriptor.url, params.token);

  return storeInboundMedia(deps, {
    bytes,
    mime: descriptor.mimeType,
    agentId: params.agentId,
    waMessageId: params.waMessageId,
  });
}

export interface StoreParams {
  bytes: Buffer;
  mime: string;
  agentId: string;
  waMessageId: string;
}

/**
 * Writes bytes already in hand, and answers where they went.
 *
 * The Graph path fetches and then calls this; a linked device downloads through its own
 * socket and calls this with what came back. Naming and layout live here precisely so both
 * are served by the one media route, and so a file's name still says which message it
 * belongs to whichever transport brought it.
 */
export async function storeInboundMedia(
  deps: { mediaDir: string },
  params: StoreParams,
): Promise<{ path: string; mime: string }> {
  if (params.bytes.byteLength > MAX_BYTES) {
    throw new Error(`Media for ${params.waMessageId} is ${params.bytes.byteLength} bytes, over the limit`);
  }

  // Grouped by agent so one client's files can be moved or removed on their own, and named
  // by the WhatsApp message id, which is unique and already stored on the row.
  const relative = join(
    params.agentId,
    `${params.waMessageId.replace(/[^\w.-]/g, '_')}${extensionFor(params.mime)}`,
  );
  const absolute = join(deps.mediaDir, relative);

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, params.bytes);

  return { path: relative, mime: params.mime };
}
