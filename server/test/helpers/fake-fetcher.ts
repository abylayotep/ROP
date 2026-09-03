import type { FetchedPage, PageFetcher } from '../../src/lib/knowledge/fetch-page.js';

export interface FakeFetcher extends PageFetcher {
  /** Every URL asked for, in order. */
  calls: string[];
}

/**
 * What a fake page can be: its HTML, a failure, or a page reached after a redirect.
 *
 * The third exists because the real fetcher follows redirects and answers with where it
 * ended up, and most real addresses redirect — `http` to `https`, bare to `www`. Answering
 * `finalUrl === url` for everything made that path untestable, and the routes' handling of
 * it was wrong in a way no test could see.
 */
export type FakePage = string | Error | FetchedPage;

/**
 * A fetcher that answers from a map and records what it was asked.
 *
 * `pages` maps a URL to its HTML; anything else, or a value that is an Error, is thrown. A
 * `{ html, finalUrl }` value is a page that redirected on the way.
 */
export function fakeFetcher(pages: Record<string, FakePage>): FakeFetcher {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string) {
      calls.push(url);
      const answer = pages[url];
      if (answer === undefined) throw new Error(`нет страницы для ${url}`);
      if (answer instanceof Error) throw answer;
      return typeof answer === 'string' ? { html: answer, finalUrl: url } : answer;
    },
  };
}
