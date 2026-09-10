/**
 * The `[[targets]]` a body points at, once each, in the order they were written.
 *
 * Case-insensitively deduplicated and resolved the same way, because a note title is a name a
 * person typed twice and expects to be the same name both times. The first spelling wins, so
 * a broken link reads back the way its author wrote it.
 */
export function parseLinks(body: string): string[] {
  const withoutFences = body.replace(/```[\s\S]*?(```|$)/g, '');
  const found = new Map<string, string>();
  for (const match of withoutFences.matchAll(/\[\[([^\]|[\n]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = match[1]!.trim();
    if (target === '') continue;
    const key = target.toLocaleLowerCase('ru');
    if (!found.has(key)) found.set(key, target);
  }
  return [...found.values()];
}
