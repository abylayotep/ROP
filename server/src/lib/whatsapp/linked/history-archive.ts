import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { linkedHistoryPackets } from '../../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../secret-box.js';
import type { RawLinkedHistory } from './client.js';
import { applyHistoryChunkWithReport } from './history.js';

interface ArchiveDeps {
  download(notification: string): Promise<string>;
  decode(payload: string, notification?: string): RawLinkedHistory;
  onImported?(numberId: string, chunk: RawLinkedHistory): void;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Durable inbox. Failed/partial packets remain replayable until their ciphertext expires. */
export function createHistoryArchive(db: Db, key: Buffer, deps: ArchiveDeps) {
  let draining = false;
  return {
    async capture(numberId: string, notification: string): Promise<void> {
      const id = randomUUID();
      await db.insert(linkedHistoryPackets).values({
        id, numberId, digest: createHash('sha256').update(notification).digest('hex'),
        notification: encryptSecret(notification, key, `history:${numberId}:${id}:notification`),
        expiresAt: new Date(Date.now() + RETENTION_MS),
      }).onConflictDoNothing();
    },
    async drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        const now = new Date();
        await db.update(linkedHistoryPackets).set({ payload: null, notification: null,
          status: 'expired', updatedAt: now }).where(and(lt(linkedHistoryPackets.expiresAt, now), ne(linkedHistoryPackets.status, 'expired')));
        // A process killed mid-import leaves a lease. Retrying is safe because message IDs deduplicate.
        await db.update(linkedHistoryPackets).set({ status: 'queued', updatedAt: now })
          .where(and(eq(linkedHistoryPackets.status, 'processing'), lt(linkedHistoryPackets.updatedAt, new Date(Date.now() - 30 * 60_000))));
        const pending = await db.select({ id: linkedHistoryPackets.id }).from(linkedHistoryPackets)
          .where(and(eq(linkedHistoryPackets.status, 'queued'), gt(linkedHistoryPackets.expiresAt, now)))
          .orderBy(asc(linkedHistoryPackets.createdAt)).limit(10);
        for (const candidate of pending) {
          const [packet] = await db.update(linkedHistoryPackets)
            .set({ status: 'processing', attempts: sql`${linkedHistoryPackets.attempts} + 1`, updatedAt: new Date(), errorCode: null })
            .where(and(eq(linkedHistoryPackets.id, candidate.id), eq(linkedHistoryPackets.status, 'queued'), gt(linkedHistoryPackets.expiresAt, new Date())))
            .returning();
          if (!packet) continue;
          const aad = `history:${packet.numberId}:${packet.id}`;
          const ownedLease = () => and(eq(linkedHistoryPackets.id, packet.id),
            eq(linkedHistoryPackets.status, 'processing'), eq(linkedHistoryPackets.attempts, packet.attempts),
            gt(linkedHistoryPackets.expiresAt, new Date()));
          try {
            const notification = packet.notification ? decryptSecret(packet.notification, key, `${aad}:notification`) : undefined;
            let payload: string;
            if (packet.payload) payload = decryptSecret(packet.payload, key, `${aad}:payload`);
            else {
              if (!notification) throw new Error('Missing notification');
              payload = await deps.download(notification);
              // This commit MUST precede decoding, mapping and importing any message.
              const saved = await db.update(linkedHistoryPackets).set({ payload: encryptSecret(payload, key, `${aad}:payload`), updatedAt: new Date() })
                .where(ownedLease()).returning({ id: linkedHistoryPackets.id });
              if (!saved.length) continue;
            }
            const chunk = deps.decode(payload, notification);
            const committed = await db.transaction(async tx => {
              const [lease] = await tx.select({ id: linkedHistoryPackets.id }).from(linkedHistoryPackets)
                .where(ownedLease()).for('update');
              if (!lease) return false;
              // Import helpers use only Db query methods, also supplied by this transaction.
              const counts = await applyHistoryChunkWithReport(tx as unknown as Db, packet.numberId, chunk);
              const completed = await tx.update(linkedHistoryPackets)
                .set({ counts, status: counts.skippedUnresolved ? 'partial' : 'done', updatedAt: new Date() })
                .where(ownedLease()).returning({ id: linkedHistoryPackets.id });
              if (!completed.length) throw new Error('History lease expired during import');
              return true;
            });
            if (committed) {
              try { deps.onImported?.(packet.numberId, { ...chunk, alreadyStored: true }); }
              catch { /* Observers cannot change an already committed import result. */ }
            }
          } catch {
            // Neither decoder errors nor network URLs may expose customer payloads/keys.
            await db.update(linkedHistoryPackets).set({ status: 'failed', errorCode: 'processing_failed', updatedAt: new Date() })
              .where(ownedLease());
          }
        }
      } finally { draining = false; }
    },
  };
}
