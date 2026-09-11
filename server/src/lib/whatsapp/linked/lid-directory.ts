/** A bounded, process-local directory of phone numbers behind WhatsApp LIDs. */
const MAX_ENTRIES = 10_000;

const phones = new Map<string, string>();
const keyOf = (numberId: string, lid: string): string => `${numberId}:${lid}`;

/** Remember one mapping inside the linked number that observed it. */
export function rememberLid(numberId: string, lid: string, phone: string): void {
  const key = keyOf(numberId, lid);
  phones.delete(key);
  phones.set(key, phone);
  if (phones.size > MAX_ENTRIES) {
    const oldest = phones.keys().next();
    if (!oldest.done) phones.delete(oldest.value);
  }
}

/** Resolve a LID only inside its linked number; another tenant's mapping never applies. */
export function phoneForLid(numberId: string, lid: string): string | null {
  return phones.get(keyOf(numberId, lid)) ?? null;
}

/** Tests only: the process-local directory otherwise intentionally survives a test case. */
export function forgetLids(): void {
  phones.clear();
}
