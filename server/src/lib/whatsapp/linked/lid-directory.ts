/**
 * Which phone number is behind a LID.
 *
 * WhatsApp is moving one-to-one chats off phone numbers and onto LIDs — an opaque account
 * id — and a socket now addresses such a chat as `<lid>@lid`. A customer's own message
 * still carries their number alongside it (`key.senderPn`), so their side of the migration
 * costs us nothing. The owner's replies from their handset do not: those carry the owner's
 * number, and the only thing naming the customer is the LID.
 *
 * So the customer's messages fill this directory and the owner's messages read it. It is
 * memory, not a source of truth: a LID nobody has written from since the process started
 * is unknown, and the line it belongs to is dropped with a line in the log rather than
 * filed under the wrong person. Persisting it would be a migration, and the case it would
 * buy — the owner answering from the handset, on a LID chat, with no incoming message
 * since the last restart — is not worth a column that then has to be kept true.
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

/** Digits only, both of them: `4304144453830` → `77085807932`. */
export function rememberLid(lid: string, phone: string): void {
  // Re-inserted rather than updated, so the map's own order stays youngest-last and the
  // eviction below drops a LID nobody has written from in a long time.
  phones.delete(lid);
  phones.set(lid, phone);
  if (phones.size > MAX_ENTRIES) {
    const oldest = phones.keys().next();
    if (!oldest.done) phones.delete(oldest.value);
  }
}

/** The number behind a LID, or null when no message has named it yet. */
export function phoneForLid(lid: string): string | null {
  return phones.get(lid) ?? null;
}

/** Tests only: the directory outlives a single case otherwise. */
export function forgetLids(): void {
  phones.clear();
}
