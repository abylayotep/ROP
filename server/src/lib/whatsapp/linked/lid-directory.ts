/**
 * Which phone number is behind a LID.
 *
 * WhatsApp is moving one-to-one chats off phone numbers and onto LIDs — an opaque account
 * id — and a socket now addresses such a chat as `<lid>@lid`. A customer's own message
 * still carries their number alongside it (`key.senderPn`), so their side of the migration
 * costs us nothing. The owner's replies from their handset do not: those carry the owner's
 * number, and the only thing naming the customer is the LID.
 *
 * So the customer's messages fill this directory and the owner's messages read it. Each
 * mapping is scoped to the linked number that observed it, so one tenant can never resolve
 * another tenant's chat. It is memory, not a source of truth: a LID nobody has written from
 * since the process started is unknown and the line is dropped rather than filed under the
 * wrong person.
 *
 * Baileys 6.7.24 has no mapping of its own to ask; when it grows one, this file is what
 * that replaces.
 */

/**
 * Enough for every customer a shop hears from between restarts, and bounded because this
 * lives for the life of the process and nothing above it ever forgets a conversation.
 */
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
