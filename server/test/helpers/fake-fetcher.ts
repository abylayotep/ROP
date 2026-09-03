import type { PageFetcher } from '../../src/lib/knowledge/fetch-page.js';

export interface FakeFetcher extends PageFetcher {
  /** Every URL asked for, in order. */
  calls: string[];
}

/**
 * A fetcher that answers from a map and records what it was asked.
 *
 * `pages` maps a URL to its HTML; anything else, or a value that is an Error, is thrown.
 */
export function fakeFetcher(pages: Record<string, string | Error>): FakeFetcher {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string) {
      calls.push(url);
      const answer = pages[url];
      if (answer === undefined) throw new Error(`нет страницы для ${url}`);
      if (answer instanceof Error) throw answer;
      return { html: answer, finalUrl: url };
    },
  };
}
