/**
 * The real `createPageFetcher`, driven directly.
 *
 * Everything else in this stage injects a fake fetcher, which is right for the routes and
 * leaves the guards — the scheme, the address, the content type, the byte cap, the deadline
 * and the redirect chain — exercised by nothing at all. They are the security boundary of
 * the page import, so they are tested here, against a stubbed `fetch` and a stubbed
 * resolver. No socket is opened and no name is looked up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

import {
  PAGE_REFUSED,
  PageError,
  createPageFetcher,
  fetchPage,
  htmlToText,
} from '../src/lib/knowledge/fetch-page.js';

const fetcher = createPageFetcher();

/** A public address, so a test that is not about DNS does not have to say so. */
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

let asked: string[] = [];

/** Stubs `fetch`, recording every URL it is given, and answers with `reply`. */
function answering(reply: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(String(url));
    return reply(String(url));
  });
}

const page = (body: string, type = 'text/html; charset=utf-8') =>
  new Response(body, { status: 200, headers: { 'content-type': type } });

const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

beforeEach(() => {
  asked = [];
  lookup.mockReset();
  lookup.mockResolvedValue(PUBLIC);
  answering(() => page('<h1>Сафина</h1><p>Двери.</p>'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const refusal = (url: string) => fetcher.fetch(url).catch((error: unknown) => error);

/** Serves `html` at a fixed address and returns it, for `fetchPage`'s own tests. */
function url(html: string): string {
  answering(() => page(html));
  return 'https://safina.kz/';
}

describe('the address guard', () => {
  it('reads an ordinary page', async () => {
    const fetched = await fetcher.fetch('https://safina.kz/');

    expect(fetched.html).toContain('Сафина');
    expect(fetched.finalUrl).toBe('https://safina.kz/');
  });

  it('refuses a scheme that is not http or https, without opening anything', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'ftp://a/b', 'нет']) {
      const error = await refusal(url);
      expect(error, url).toBeInstanceOf(PageError);
    }
    expect(asked).toEqual([]);
  });

  it('refuses an address literal that is not routable from outside', async () => {
    const internal = [
      'http://127.0.0.1:55432/',
      'http://[::1]/',
      'http://[0:0:0:0:0:0:0:1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
    ];

    for (const url of internal) {
      const error = await refusal(url);
      expect(error, url).toBeInstanceOf(PageError);
    }
    // Never resolved and never dialled: a literal needs no lookup to be judged.
    expect(lookup).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('refuses everything that is not a global unicast address', async () => {
    // Each of these reached its destination under a guard that enumerated bad ranges instead
    // of naming the one good one. The four IPv6 forms that carry an IPv4 address inside them
    // are the interesting half: they reach exactly what that IPv4 address reaches.
    const notPublic = [
      'http://[64:ff9b::7f00:1]/', // NAT64 well-known prefix to 127.0.0.1
      'http://[64:ff9b:1::7f00:1]/', // NAT64 with an RFC 8215 prefix
      'http://[::7f00:1]/', // IPv4-compatible to 127.0.0.1
      'http://[2002:7f00:1::]/', // 6to4 to 127.0.0.1
      'http://[ff02::1]/', // multicast, all nodes on the link
      'http://[fec0::1]/', // deprecated site-local
      'http://224.0.0.1/', // multicast
      'http://255.255.255.255/', // broadcast
      'http://192.0.0.1/', // IETF protocol assignments
      'http://198.18.0.1/', // benchmarking
      'http://192.0.2.1/', // TEST-NET-1
      'http://192.88.99.1/', // 6to4 relay anycast
      'http://[2001:db8::1]/', // documentation
      'http://[100::1]/', // discard-only
    ];

    for (const url of notPublic) {
      const error = await refusal(url);
      expect(error, url).toBeInstanceOf(PageError);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('still allows the public addresses the rule is meant to let through', async () => {
    for (const url of [
      'http://93.184.216.34/',
      'http://8.8.8.8/',
      'http://[2606:4700::1111]/',
      'http://[::ffff:8.8.8.8]/', // IPv4-mapped, but mapped onto a public address
      'http://[64:ff9b::8.8.8.8]/', // NAT64 onto a public address
    ]) {
      await expect(fetcher.fetch(url), url).resolves.toBeDefined();
    }
  });

  it('refuses a name that resolves to a loopback address', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    expect(await refusal('http://localhost/admin')).toBeInstanceOf(PageError);
    expect(asked).toEqual([]);
  });

  it('refuses a name with one public answer and one private one', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]);

    expect(await refusal('https://safina.kz/')).toBeInstanceOf(PageError);
    expect(asked).toEqual([]);
  });

  it('allows an ordinary public name', async () => {
    await expect(fetcher.fetch('https://safina.kz/')).resolves.toBeDefined();
    expect(lookup).toHaveBeenCalledWith('safina.kz', { all: true });
  });
});

describe('redirects', () => {
  it('checks every hop, so a redirect into the metadata service is refused', async () => {
    answering((url) =>
      url === 'https://safina.kz/' ? redirect('http://169.254.169.254/') : page('<p>секрет</p>'),
    );

    expect(await refusal('https://safina.kz/')).toBeInstanceOf(PageError);
    // The first hop happened; the second was refused before a socket was opened.
    expect(asked).toEqual(['https://safina.kz/']);
  });

  it('checks the scheme of a hop too', async () => {
    answering(() => redirect('file:///etc/passwd'));

    expect(await refusal('https://safina.kz/')).toBeInstanceOf(PageError);
    expect(asked).toEqual(['https://safina.kz/']);
  });

  it('follows a redirect and reports where it ended', async () => {
    answering((url) =>
      url === 'https://safina.kz/' ? redirect('/about') : page('<h1>О нас</h1><p>Двери.</p>'),
    );

    const fetched = await fetcher.fetch('https://safina.kz/');

    expect(fetched.finalUrl).toBe('https://safina.kz/about');
    expect(fetched.html).toContain('О нас');
  });

  it('gives up on a chain that never lands', async () => {
    let hop = 0;
    answering(() => {
      hop += 1;
      return redirect(`https://safina.kz/${hop}`);
    });

    expect(await refusal('https://safina.kz/')).toBeInstanceOf(PageError);
    // One request, then five follows, and then it stops.
    expect(asked).toHaveLength(6);
  });
});

describe('the response', () => {
  it('refuses a content type that is not HTML', async () => {
    for (const type of ['application/json', 'video/mp4', 'application/pdf', '']) {
      answering(() => page('{}', type));
      const error = await refusal('https://safina.kz/');
      expect(error, type).toBeInstanceOf(PageError);
    }
  });

  it('refuses a status that is not ok', async () => {
    answering(() => new Response('nope', { status: 401, headers: { 'content-type': 'text/html' } }));

    expect(await refusal('https://safina.kz/')).toBeInstanceOf(PageError);
  });

  it('stops reading at the cap and lets go of the stream', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1024);
    answering(
      () =>
        new Response(
          new ReadableStream({
            // Never ends. This is the case the cap exists for, and holding the reader open
            // afterwards would leave the socket exactly as stuck as reading forever.
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    );

    expect(await refusal('https://safina.kz/')).toBeInstanceOf(PageError);
    expect(cancelled).toBe(true);
  });

  it('turns a deadline that expires during the body into a page error', async () => {
    answering(
      () =>
        new Response(
          new ReadableStream({
            pull() {
              // What Node raises for an expired `AbortSignal.timeout`. It arrives on the body
              // read rather than on `fetch`, which resolved as soon as the headers did.
              const expired = new Error('The operation was aborted due to timeout');
              expired.name = 'TimeoutError';
              throw expired;
            },
          }),
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    );

    const error = await refusal('https://safina.kz/');

    expect(error).toBeInstanceOf(PageError);
    expect((error as PageError).message).toBe(PAGE_REFUSED);
  });

  it('says the same thing however it failed, and keeps the detail off the screen', async () => {
    answering(() => new Response('', { status: 401, headers: { 'content-type': 'text/html' } }));
    const unauthorised = (await refusal('https://safina.kz/')) as PageError;

    answering(() => page('{}', 'application/json'));
    const wrongType = (await refusal('https://safina.kz/')) as PageError;

    // One sentence for both: the status and the content type of whatever answered would
    // together make this import box a port scanner for the client's own network.
    expect(unauthorised.message).toBe(PAGE_REFUSED);
    expect(wrongType.message).toBe(PAGE_REFUSED);
    expect(unauthorised.detail).toContain('401');
    expect(wrongType.detail).toContain('application/json');
  });
});

describe('the charset', () => {
  // «Двери» in windows-1251, which is what a Russian site built a decade ago still serves.
  const CP1251 = [0xc4, 0xe2, 0xe5, 0xf0, 0xe8];
  const body = (prefix: string, suffix = '</p>') =>
    Uint8Array.from([
      ...[...prefix].map((char) => char.charCodeAt(0)),
      ...CP1251,
      ...[...suffix].map((char) => char.charCodeAt(0)),
    ]);

  it('honours the charset in the content type', async () => {
    answering(
      () =>
        new Response(body('<p>'), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=windows-1251' },
        }),
    );

    expect((await fetcher.fetch('https://safina.kz/')).html).toContain('Двери');
  });

  it('falls back to the charset the document declares', async () => {
    answering(
      () =>
        new Response(body('<meta charset="windows-1251"><p>'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    expect((await fetcher.fetch('https://safina.kz/')).html).toContain('Двери');
  });

  it('refuses a charset it cannot honour rather than importing rubbish', async () => {
    answering(() => page('<p>Двери</p>', 'text/html; charset=x-unknown-9000'));

    expect(await refusal('https://safina.kz/')).toBeInstanceOf(PageError);
  });
});

describe('htmlToText, on what a real page does wrong', () => {
  it('drops a script that was never closed, which is what the cap leaves behind', () => {
    const cut = '<h1>Прайс</h1><p>Двери.</p><script>var CONFIG={apiKey:"secret",';

    const text = htmlToText(cut);

    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('secret');
    expect(text).toContain('# Прайс');
    expect(text).toContain('Двери.');
  });

  it('keeps a self-closing tag from taking the rest of the page with it', () => {
    expect(htmlToText('<p>До</p><svg/><p>После</p>')).toContain('После');
  });

  it('puts every cell of a price table on its own line', () => {
    const table = '<table><tr><td>Дверь</td><td>50000 тг</td></tr></table>';

    expect(htmlToText(table)).toContain('Дверь\n50000 тг');
  });

  it('drops a control character rather than letting it reach the insert', () => {
    const text = htmlToText('<p>Дверь&#0; за 50000</p>');

    expect(text).not.toContain(' ');
    expect(text).toContain('Дверь');
    expect(text).toContain('50000');
  });
});

describe('fetchPage', () => {
  it('keeps the page headings as markdown headings', async () => {
    const page = await fetchPage(url('<h1>Двери</h1><p>Металл.</p><h2>Доставка</h2><p>1500 ₸.</p>'));

    expect(page.title).toBe('Двери');
    expect(page.markdown).toBe('# Двери\n\nМеталл.\n\n## Доставка\n\n1500 ₸.');
  });

  it('falls back to the title tag and the address when the page has no heading', async () => {
    const page = await fetchPage(url('<head><title>Сафина</title></head><p>Двери и окна.</p>'));

    expect(page.title).toBe('Сафина — safina.kz');
    expect(page.markdown).toBe('Двери и окна.');
  });

  it('clamps a heading long enough to overflow the path index, rather than 500ing on it', async () => {
    // `TITLE_MAX` is 200 code points; the import route builds `С сайта/<title>` into a path
    // under a unique btree index whose entries top out around 2704 bytes, and an unclamped
    // first heading this long would raise Postgres's 54000 there instead of importing.
    const heading = 'Очень длинный заголовок страницы, '.repeat(30);
    const page = await fetchPage(url(`<h1>${heading}</h1><p>Металл.</p>`));

    expect(page.title.length).toBeLessThanOrEqual(200);
    expect(page.title.endsWith('…')).toBe(true);
  });

  it('goes through the same address guard as the raw fetcher', async () => {
    const error = await fetchPage('http://127.0.0.1/admin').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PageError);
    expect((error as PageError).message).toBe(PAGE_REFUSED);
  });
});
