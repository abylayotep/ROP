import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphClient, GRAPH_ROOT } from '../src/lib/whatsapp/graph.js';

let directory: string;
let path: string;
const contents = Buffer.from('test media bytes');
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'graph-media-'));
  path = join(directory, 'payment.png');
  await writeFile(path, contents);
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Cloud file delivery', () => {
  it('uploads local bytes as multipart and sends the returned image id', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ id: 'media-1' })).mockResolvedValueOnce(response({ messages: [{ id: 'wamid.1' }] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(createGraphClient().sendMedia!('phone-1', 'secret', '77001234567', { path, mime: 'image/png', caption: 'Оплата' })).resolves.toEqual({ messageId: 'wamid.1' });
    const [uploadUrl, upload] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(uploadUrl).toBe(`${GRAPH_ROOT}/phone-1/media`);
    expect(upload.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(upload.signal).toBeInstanceOf(AbortSignal);
    const form = upload.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('image/png');
    const file = form.get('file') as File;
    expect(file.name).toBe('payment.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(contents);
    expect(fetcher.mock.calls[1]![0]).toBe(`${GRAPH_ROOT}/phone-1/messages`);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '77001234567', type: 'image', image: { id: 'media-1', caption: 'Оплата' } });
  });

  it.each([
    ['application/pdf', 'document', { id: 'media-1', caption: 'Описание', filename: 'invoice.pdf' }],
    ['video/mp4', 'video', { id: 'media-1', caption: 'Описание' }],
    ['audio/ogg', 'audio', { id: 'media-1' }],
  ])('uses the correct message payload for %s', async (mime, kind, media) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ id: 'media-1' })).mockResolvedValueOnce(response({ messages: [{ id: 'wamid.1' }] }));
    vi.stubGlobal('fetch', fetcher);
    await createGraphClient().sendMedia!('phone-1', 'secret', '77001234567', { path, mime, filename: 'invoice.pdf', caption: 'Описание' });
    const sent = JSON.parse(fetcher.mock.calls[1]![1].body);
    expect(sent.type).toBe(kind);
    expect(sent[kind]).toEqual(media);
  });

  it('never sends a message when upload fails', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: { message: 'Unsupported file', code: 100 } }, 400));
    vi.stubGlobal('fetch', fetcher);
    await expect(createGraphClient().sendMedia!('phone-1', 'secret', '77001234567', { path, mime: 'image/png' })).rejects.toMatchObject({ status: 400, code: 100 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses successful upload responses without an id', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal('fetch', fetcher);
    await expect(createGraphClient().sendMedia!('phone-1', 'secret', '77001234567', { path, mime: 'image/png' })).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not claim delivery when Meta returns no message id', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ id: 'media-1' })).mockResolvedValueOnce(response({ messages: [] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(createGraphClient().sendMedia!('phone-1', 'secret', '77001234567', { path, mime: 'image/png' })).rejects.toMatchObject({ status: 502 });
  });
});
