import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The one outbound HTTP request this product makes on somebody else's behalf.
 *
 * An owner pastes the address of their own site and we go and read it. That is the whole
 * feature, and it is also the whole danger: this process sits inside the client's network,
 * and a URL typed by a person can name their own intranet as easily as their shop. Whatever
 * comes back is stored and handed straight out again by `GET /knowledge/items`, so a fetch
 * that is allowed to reach `127.0.0.1` or `169.254.169.254` is an exfiltration channel with
 * a text box in front of it. Every guard below is there for that, and none of them is
 * optional.
 *
 * It is an interface first and an implementation second, the same way the Graph client is:
 * the routes take a `PageFetcher`, so the API tests inject a fake and never reach the
 * network — and `knowledge-fetch-page.test.ts` drives the real one against a stubbed
 * `fetch`, because the guards are the security boundary and a boundary nothing exercises is
 * a boundary nobody knows is there.
 */

/** A page, as fetched. `finalUrl` is where the redirects ended, which is the page we read. */
export interface FetchedPage {
  html: string;
  finalUrl: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

/** The same deadline the Graph client takes: a page is on an owner's request path. */
const TIMEOUT_MS = 15_000;
/** Enforced while reading, not after: a server that streams forever must not fill memory. */
const MAX_BYTES = 2_000_000;
/** Enough for any site that means well; a loop is what the rest of them are doing. */
const MAX_HOPS = 5;
/** How much of the body is searched for a `<meta charset>` — the head, and not much of it. */
const SNIFF_BYTES = 1024;

/** What a browser sends, so a site that varies by `Accept` gives us the page and not JSON. */
const ACCEPT = 'text/html,application/xhtml+xml';
/** The types we can turn into text. Anything else is a download, not a page. */
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
/** The statuses that mean «not here, there». 304 is not one: nothing here sends `If-*`. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The single sentence an owner is shown when a page could not be read.
 *
 * Deliberately one sentence for every network-level outcome. Saying «Страница ответила HTTP
 * 401» or «не веб-страница: application/json» answers, precisely and for free, the question
 * «is there something listening on this host and port» — which turns an owner-only import
 * box into a port scanner pointed at the client's own network, and it is the same box the
 * address guard below exists to protect. What actually happened goes to `app.log`, where the
 * people who need it can read it and a customer cannot.
 *
 * The two failures that are genuinely the owner's to fix keep their own words, because there
 * they can act on them: an address that is not http(s), and a page that held no text.
 */
export const PAGE_REFUSED = 'Не удалось загрузить страницу. Проверьте адрес и доступность сайта.';

/**
 * A page that could not be read.
 *
 * `message` is the same general sentence every time and is safe to show; `detail` says what
 * really happened and is for the log alone. The route branches on this class to tell a page
 * that would not load — a 502, with `message` on screen — from a bug in us, which is a 500.
 */
export class PageError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(PAGE_REFUSED);
    this.name = 'PageError';
    this.detail = detail;
  }
}

/**
 * The rule is: a global unicast address, and nothing else.
 *
 * This started as a list of the ranges that looked dangerous, which is the wrong shape for
 * the job — the set of addresses that are not the public internet is large, oddly spelled and
 * still growing, and a reviewer walked `[64:ff9b::7f00:1]`, `[::7f00:1]`, `[2002:7f00:1::]`,
 * `[fec0::1]`, `224.0.0.1` and `255.255.255.255` straight past it. So the question below is
 * not «is this address on the bad list» but «is this address one of the ordinary public ones»,
 * and everything that is not — reserved, multicast, private, link-local, documentation,
 * benchmarking, or a spelling we do not recognise — is refused.
 *
 * Add a range to a table below when one is missed. Do not go back to reasoning about it.
 */

/**
 * IPv4 ranges that are not global unicast, as `[network, prefix length]`.
 *
 * `224/4` and `240/4` at the end are what make this list finite: between them they hold all
 * of multicast, everything IANA has reserved, and the broadcast address `255.255.255.255`.
 */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network" — some stacks route it to localhost
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback: this process, and the database beside it
  ['169.254.0.0', 16], // link-local — 169.254.169.254 is the cloud metadata service
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255 with it
];

/** The same for IPv6. The four prefixes that carry an IPv4 address are handled separately. */
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique-local: the client's own network
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local: deprecated, and still routed by kit that predates that
  ['ff00::', 8], // multicast
];

/** A dotted quad as a 32-bit number, or null when it is not one. */
function toV4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    // Multiplied rather than shifted: `<<` works on signed 32-bit, so anything from 128.0.0.0
    // up would come out negative and compare against the table as some other address.
    value = value * 256 + octet;
  }
  return value;
}

/**
 * An IPv6 address as its eight hextets, or null when we cannot read it.
 *
 * Written out rather than prefix-matched on the text: a prefix test on how somebody spelled an
 * address is a test of the spelling, and `::ffff:127.0.0.1`, `[::ffff:7f00:1]` and
 * `0:0:0:0:0:ffff:7f00:1` are three spellings of one address.
 */
function toV6(raw: string): number[] | null {
  // A zone index (`fe80::1%eth0`) is routing, not identity, and never part of the prefix.
  const value = raw.toLowerCase().split('%')[0] ?? '';
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const expand = (text: string): number[] | null => {
    if (text === '') return [];
    const groups: number[] = [];
    const parts = text.split(':');
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      // A trailing dotted quad — `::ffff:127.0.0.1` — is worth two hextets and can only be
      // last. Anywhere else it is not an address we know how to read.
      if (part.includes('.')) {
        if (index !== parts.length - 1) return null;
        const embedded = toV4(part);
        if (embedded === null) return null;
        groups.push(Math.floor(embedded / 0x10000), embedded % 0x10000);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const left = expand(halves[0]!);
  const right = halves.length === 2 ? expand(halves[1]!) : [];
  if (left === null || right === null) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const gap = 8 - left.length - right.length;
  // `::` has to stand for at least one hextet, or it would not have been written.
  if (gap < 1) return null;
  return [...left, ...(new Array<number>(gap).fill(0) as number[]), ...right];
}

const inPrefixV4 = (value: number, network: number, bits: number): boolean =>
  bits === 0 || value >>> (32 - bits) === network >>> (32 - bits);

function inPrefixV6(address: number[], network: number[], bits: number): boolean {
  let left = bits;
  for (let index = 0; index < 8 && left > 0; index += 1) {
    const take = Math.min(16, left);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((address[index]! & mask) !== (network[index]! & mask)) return false;
    left -= take;
  }
  return true;
}

/** An address we could not read is one we do not fetch: unreadable is not a reason to trust. */
function isBlockedV4(address: string): boolean {
  const value = toV4(address);
  if (value === null) return true;

  return BLOCKED_V4.some(([network, bits]) => {
    const parsed = toV4(network);
    return parsed !== null && inPrefixV4(value, parsed, bits);
  });
}

/** Two hextets back into the IPv4 address they hold. */
const embeddedV4 = (high: number, low: number): string =>
  [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');

/**
 * IPv6, judged as IPv6 — except where it is IPv4 wearing a hat.
 *
 * Four prefixes carry an IPv4 address inside them, and each of them reaches exactly what that
 * IPv4 address reaches: `::ffff:a.b.c.d` (mapped), `::a.b.c.d` (compatible), `64:ff9b::/96`
 * (the well-known NAT64 prefix, which every DNS64 subnet AWS hands out will translate) and
 * `2002::/16` (6to4). All four are therefore unwrapped and judged by the IPv4 table, which is
 * the same reasoning that `::ffff:` needed and the same that the other three were missing.
 */
function isBlockedV6(raw: string): boolean {
  const address = toV6(raw);
  if (address === null) return true;

  for (const [network, bits] of BLOCKED_V6) {
    const parsed = toV6(network);
    if (parsed !== null && inPrefixV6(address, parsed, bits)) return true;
  }

  const [first, second, third, , , sixth, seventh, eighth] = address as number[];
  const leadingZeroes = (count: number) => address.slice(0, count).every((hextet) => hextet === 0);

  // ::ffff:a.b.c.d — IPv4-mapped.
  if (leadingZeroes(5) && sixth === 0xffff) return isBlockedV4(embeddedV4(seventh!, eighth!));
  // 64:ff9b::/96 — the well-known NAT64 prefix.
  if (first === 0x64 && second === 0xff9b && address.slice(2, 6).every((hextet) => hextet === 0)) {
    return isBlockedV4(embeddedV4(seventh!, eighth!));
  }
  // 64:ff9b:1::/48 — RFC 8215 lets the four octets sit at any of six offsets inside it, so
  // there is no one place to read them from. An address we cannot judge is one we do not
  // fetch, and nothing global unicast lives in this prefix anyway.
  if (first === 0x64 && second === 0xff9b && third === 1) return true;
  // 2002::/16 — 6to4, which holds the address in the two hextets after the prefix.
  if (first === 0x2002) return isBlockedV4(embeddedV4(second!, third!));
  // ::a.b.c.d — IPv4-compatible. Last, because `::` and `::1` are in the table above and are
  // this shape too.
  if (leadingZeroes(6)) return isBlockedV4(embeddedV4(seventh!, eighth!));

  return false;
}

const isBlocked = (address: string): boolean =>
  isIP(address) === 6 ? isBlockedV6(address) : isBlockedV4(address);

/**
 * The scheme and the host of one hop, checked before this process opens a socket to it.
 *
 * Run on every hop rather than once at the start: `fetch` with `redirect: 'follow'` does the
 * hops inside itself and hands back only the last response, so a guard that runs once checks
 * an address the request may never have gone to. A public URL answering `302 Location:
 * http://169.254.169.254/` is the whole attack, and it is invisible from the outside.
 *
 * A name is refused when ANY of its addresses is blocked, not only the first: a host that
 * answers with one public and one private address is precisely the shape of the attack, and
 * which one `fetch` picks is not ours to predict.
 *
 * What remains is DNS rebinding — the name could resolve again, to something else, between
 * this check and the connection. Closing that means resolving here and then dialling the IP
 * with the hostname in a `Host` header, which breaks TLS certificate validation and every
 * virtually-hosted site on shared infrastructure, i.e. most of this product's customers.
 * Against that cost the residual risk is small and strange: importing is owner-only, so the
 * attacker would have to be the owner of the account, attacking their own knowledge base.
 */
async function checkHop(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PageError(`scheme ${url.protocol} is not http(s)`);
  }

  // `hostname` keeps the brackets around an IPv6 literal; the checks want the address.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

  if (isIP(host) !== 0) {
    if (isBlocked(host)) throw new PageError(`address ${host} is not routable from outside`);
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    throw new PageError(`cannot resolve ${host}: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new PageError(`cannot resolve ${host}`);

  const blocked = addresses.find((found) => isBlocked(found.address));
  if (blocked) throw new PageError(`${host} resolves to ${blocked.address}, which is internal`);
}

/**
 * Runs the whole exchange under one deadline — the redirect chain, the DNS lookups and the
 * body read included.
 *
 * `fetch` resolves as soon as the headers arrive, so a server that sends a header and then
 * dribbles bytes forever would sit inside the body read with the deadline already passed.
 * Node rejects an expired `AbortSignal.timeout` with a `TimeoutError` whose message is
 * English and which is not a `PageError`, so an unwrapped one would reach the owner as
 * «Внутренняя ошибка сервера» instead of the reason.
 *
 * A `PageError` is passed straight through as the first branch: everything below raises them
 * from inside this exchange, and they are already worded for the reader.
 */
async function within<T>(exchange: () => Promise<T>): Promise<T> {
  try {
    return await exchange();
  } catch (error) {
    if (error instanceof PageError) throw error;
    if ((error as { name?: string } | null)?.name === 'TimeoutError') {
      throw new PageError(`no response within ${Math.round(TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  }
}

/** Lets go of a response we are not going to read, so its socket is not held open. */
const drop = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

/**
 * The response, following redirects by hand so the guard applies to every hop.
 *
 * Returns the URL it ended at as well: with `redirect: 'manual'` there is nothing else that
 * knows where we arrived, and that URL is the page the text came from — the one worth
 * storing and reimporting later.
 */
async function get(start: URL, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
  let current = start;

  // One request, then at most MAX_HOPS follows.
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    await checkHop(current);

    const response = await fetch(current.href, {
      headers: { Accept: ACCEPT },
      redirect: 'manual',
      signal,
    });

    if (!REDIRECTS.has(response.status)) return { response, url: current };

    const location = response.headers.get('location');
    await drop(response);
    if (!location) throw new PageError(`${response.status} with no Location`);

    try {
      current = new URL(location, current);
    } catch {
      throw new PageError(`${response.status} to an unparseable Location`);
    }
  }

  throw new PageError(`more than ${MAX_HOPS} redirects`);
}

/**
 * Reads the body, counting as it goes and stopping the moment the cap is passed.
 *
 * Counted while reading rather than checked afterwards on purpose: `arrayBuffer()` on a
 * response with no end, or with a `content-length` the server lied about, pulls the whole
 * thing into this process's memory first and only then lets us object.
 *
 * Bytes rather than text, because the charset is not known until the head of the document
 * has been seen — see `decodeBody`. The cap is what bounds this array.
 */
async function readCapped(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > MAX_BYTES) throw new PageError(`body over ${MAX_BYTES} bytes`);
      chunks.push(value);
    }
  } finally {
    // Releases the socket whether we finished or gave up — and giving up is the case that
    // matters, since a stream with no end is exactly what the cap above is for. A cancel on
    // a stream that is already done or already errored is a no-op, so it needs no branch.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** The charset named by a `content-type`, if it names one. */
function labelFromType(contentType: string): string | null {
  const found = /charset\s*=\s*"?([a-z0-9_\-:.]+)"?/i.exec(contentType);
  return found ? found[1]!.toLowerCase() : null;
}

/**
 * The charset the document claims for itself, read out of the first kilobyte.
 *
 * Decoded as latin1 for the search: every label worth finding is ASCII, latin1 cannot throw
 * on any byte, and a multi-byte character cut in half by `SNIFF_BYTES` therefore cannot
 * derail the regex.
 */
function labelFromMeta(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, SNIFF_BYTES));
  const found = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-:.]+)/i.exec(head);
  return found ? found[1]!.toLowerCase() : null;
}

/**
 * The body as text, in the encoding it was actually written in.
 *
 * Assuming UTF-8 is wrong in this market, and wrong quietly: a windows-1251 site — ordinary
 * for a Russian business whose pages were built a decade ago — decodes as a page of `�`,
 * which imports without complaint and leaves the owner a knowledge base full of nothing they
 * can read. The header wins over the document, because that is what a browser does; a label
 * neither of them supplies is UTF-8, which is what the rest of the web is.
 */
function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = labelFromType(contentType) ?? labelFromMeta(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // Refused rather than retried as UTF-8: a label we cannot honour means the bytes are in
    // some encoding, and guessing produces rubbish that looks like a successful import.
    throw new PageError(`unsupported charset ${label}`);
  }
}

export function createPageFetcher(): PageFetcher {
  return {
    async fetch(raw) {
      let target: URL;
      try {
        target = new URL(raw);
      } catch {
        throw new PageError(`${raw} is not a URL`);
      }

      return within(async () => {
        // One signal for the whole exchange: the deadline covers the hops and the body read,
        // not each request on its own, so a chain of slow redirects cannot outlast it.
        const { response, url } = await get(target, AbortSignal.timeout(TIMEOUT_MS));

        if (!response.ok) {
          await drop(response);
          throw new PageError(`HTTP ${response.status} from ${url.href}`);
        }

        const type = (response.headers.get('content-type') ?? '').toLowerCase();
        // A 500 MB video answers a GET as happily as a page does, and the cap would then be
        // the only thing between us and reading it.
        if (!HTML_TYPES.some((html) => type.includes(html))) {
          await drop(response);
          throw new PageError(`content-type ${type || 'absent'} from ${url.href}`);
        }

        return { html: decodeBody(await readCapped(response), type), finalUrl: url.href };
      });
    },
  };
}

/**
 * The tags whose contents are not the page's text.
 *
 * `script` and `style` are code; `head` is metadata; `nav`, `header`, `footer`, `aside` and
 * `form` are the furniture that surrounds an article on every page of a site. Left in, they
 * would become knowledge items reading «Главная Контакты Корзина», and the agent would quote
 * them at a customer.
 */
const STRIPPED = [
  'script',
  'style',
  'noscript',
  'svg',
  'head',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
];

/**
 * `\b` after the name is what keeps `head` from eating `<header>`: without it the
 * alternation matches the first four letters and then looks for `</head>`, which on a page
 * whose `<head>` came earlier is far away — and everything between goes.
 */
const STRIPPED_RE = new RegExp(`<(${STRIPPED.join('|')})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi');

/**
 * The same tags, opened and never closed — everything from there to the end of the document.
 *
 * Run after the paired rule, so anything it matches genuinely has no closing tag. That is
 * not a hypothetical: it is what truncating at `MAX_BYTES` produces every time it fires, and
 * a page cut in the middle of a `<script>` used to import its JavaScript as a knowledge item
 * — `var CONFIG={apiKey:"…"` and whatever else the author left in there — which the agent
 * would then quote at a customer.
 *
 * Dropping the tail is the safe failure and losing content is the price: an unclosed `<form>`
 * halfway down a sloppily written page takes the rest of the page with it. Between importing
 * less of a page and importing somebody's key, less of the page is the easy choice.
 *
 * `(?<!/)` keeps a self-closing `<svg/>` out of it — that tag opens nothing.
 */
const UNCLOSED_RE = new RegExp(`<(${STRIPPED.join('|')})\\b[^>]*(?<!/)>[\\s\\S]*$`, 'i');

/**
 * The entities a Russian page actually carries, plus the ones any page carries.
 *
 * `&amp;` is deliberately not here: it is decoded last, on its own, because doing it with
 * the rest turns `&amp;lt;` into `<` — text the page showed as `&lt;` becoming markup.
 */
const ENTITIES: Record<string, string> = {
  '&nbsp;': '\u00a0',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&laquo;': '«',
  '&raquo;': '»',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

/**
 * A numeric reference, or nothing when it names something a text column cannot hold.
 *
 * The C0 controls go the same way and for the same reason `normalise` drops them in
 * `split.ts`: Postgres will not hold a NUL in a text column at all, so `&#0;` on a page —
 * and it is on more pages than one would think — reached the insert and came back to the
 * owner as «Внутренняя ошибка сервера». `\t` and `\n` are kept, because those are layout.
 */
function fromCode(code: number): string {
  if (code !== 0x09 && code !== 0x0a && (code < 0x20 || code === 0x7f)) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function decodeEntities(text: string): string {
  return (
    text
      .replace(/&[a-z]+;|&#39;/gi, (found) => ENTITIES[found.toLowerCase()] ?? found)
      .replace(/&#(\d+);/g, (_found, digits: string) => fromCode(Number(digits)))
      .replace(/&#x([0-9a-f]+);/gi, (_found, hex: string) => fromCode(Number.parseInt(hex, 16)))
      // Last, always.
      .replace(/&amp;/gi, '&')
  );
}

/** A heading's own markup removed and its text put on one line, ready for the `#` prefix. */
const oneLine = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A page's HTML as the text underneath it, with its headings kept as markdown.
 *
 * No parser and no dependency: this repository has kept its runtime dependency list to eight
 * packages, and an HTML parser for one screen is not the place to break that. What follows is
 * a sequence of replacements, and the order is the whole design — the tags whose contents we
 * do not want go before the tags we turn into layout, layout goes before the blanket removal
 * of what is left, and entities go last so that a decoded `&lt;` is never mistaken for a tag.
 *
 * Headings become `#` lines because that markdown IS the note `fetchPage` below writes: the
 * structure the author gave the page becomes the structure of the note the owner reads and the
 * sections the agent quotes from it.
 */
export function htmlToText(html: string): string {
  const text = html
    // 1. Whole subtrees that are not the page's text. Replaced with a newline rather than
    //    nothing, so the word before a stripped block and the word after it stay apart.
    .replace(STRIPPED_RE, '\n')
    .replace(UNCLOSED_RE, '\n')
    // 2. Headings, to the markdown `fetchPage` below reads.
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_found, level: string, inner: string) =>
        `\n\n${'#'.repeat(Number(level))} ${oneLine(inner)}\n\n`,
    )
    // 3. The tags that are a line break rather than a word. `td` and `th` are in the list
    //    because this product's customers sell things: their pages are price tables, and
    //    without them a row arrives as «Дверь50000 тг» — one unreadable word, and a number
    //    welded to a name is a number the agent will quote wrongly.
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|th)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    // 4. Everything else that is markup, comments and the doctype included.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '');

  // 5. Entities, once the markup is gone — decoding first would turn a `&lt;` the page
  //    displays as text into a `<` that step 4 then reads as the start of a tag.
  return (
    decodeEntities(text)
      // 6. Whitespace, in the shape the splitter expects: no runs of spaces, nothing hanging
      //    off either end of a line, and never more than one blank line between two of them.
      //    `[^\S\n]` rather than ` +`, so a tab folds in, and so does the non-breaking space
      //    `&nbsp;` just became — left standing it reaches the tsvector as part of the word.
      .replace(/[^\S\n]+/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * What to call the source this page became.
 *
 * Both halves, not one or the other: the `<title>` is what the owner recognises the page by,
 * and the host and path are what tells two pages of one site apart — and a site whose every
 * page is titled «Главная» is not unusual. Either alone leaves a sources list the owner
 * cannot read.
 *
 * Read off the raw HTML, before `htmlToText` strips the `<head>` the title lives in.
 */
export function pageTitle(html: string, finalUrl: string): string {
  const url = new URL(finalUrl);
  const where = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;

  const found = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const named = found ? decodeEntities(oneLine(found[1]!)) : '';
  return named === '' ? where : `${named} — ${where}`;
}

/** A page, ready to become the one note it imports as. */
export interface PageMarkdown {
  title: string;
  markdown: string;
}

/** The text of a page's own first heading, at any level — null when it has none. */
function firstHeading(markdown: string): string | null {
  const found = /^#{1,6}\s+(.*\S)\s*$/m.exec(markdown);
  return found ? found[1]! : null;
}

/**
 * Fetches a page and turns it into the one note it becomes.
 *
 * `htmlToText` already does the hard part — it turns the page's own headings into markdown
 * `#` lines and leaves its paragraphs as the blocks between them — so there is nothing left to
 * cut here: the whole document is the note's body, verbatim.
 *
 * The title is the page's own first heading, whatever level it is: that is the line the note
 * opens with, so naming the note anything else would have its title disagree with its own
 * first line. `pageTitle` — the `<title>` tag, or the host and path when there is none — is
 * the fallback for the page that has no heading at all, which is also the only case it is
 * still needed for; the host-plus-name shape it builds is for a page identified by where it
 * lives, and a page that is about to be one note is better named by what that note says.
 *
 * Takes a `PageFetcher` rather than reaching for `createPageFetcher()` itself, so a route can
 * hand it the same fake the rest of the import routes are tested against; the default is the
 * real fetcher, which is what lets `knowledge-fetch-page.test.ts` drive this function alone
 * and exercise the guards end to end, against a stubbed `fetch` rather than a fake `PageFetcher`.
 */
export async function fetchPage(url: string, fetcher: PageFetcher = createPageFetcher()): Promise<PageMarkdown> {
  const { html, finalUrl } = await fetcher.fetch(url);
  const markdown = htmlToText(html);
  return { title: firstHeading(markdown) ?? pageTitle(html, finalUrl), markdown };
}
