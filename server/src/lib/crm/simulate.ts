import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { AiSandboxCheckout, AiTurnField } from '@rakurs/contract';
import type { Db } from '../../db/client.js';
import { agents, aiSandboxSessions, aiSandboxTurns, leadFields, stages } from '../../db/schema.js';
import type { TurnDeps } from '../ai/turn.js';
import { keyAad } from '../ai/turn.js';
import { decryptSecret } from '../secret-box.js';
import { crmPrompt, parseCrmAnalysis, resolveCrmStage } from './analysis.js';

export interface SimulatedCrm {
  stage: { id: string; name: string } | null;
  fields: AiTurnField[];
  summary: string;
  profile: Record<string, string>;
  checkout: AiSandboxCheckout | null;
  error: string | null;
}

/** Run the live CRM prompt and evidence parser without entering its lease or write paths. */
export async function simulateCrmAnalysis(
  db: Db, deps: TurnDeps, agent: typeof agents.$inferSelect,
  session: typeof aiSandboxSessions.$inferSelect,
  previous: (typeof aiSandboxTurns.$inferSelect)[], text: string,
): Promise<SimulatedCrm> {
  const currentId = randomUUID();
  const history = [
    ...previous.flatMap((turn) => [
      { id: `${turn.id}:client`, author: 'client', body: turn.userText, kind: 'text' },
      ...(turn.reply === null ? [] : [
        { id: `${turn.id}:ai`, author: 'ai', body: turn.reply, kind: 'text' },
      ]),
    ]),
    { id: currentId, author: 'client', body: text, kind: 'text' },
  ].slice(-50);
  const [funnel, fieldRows] = await Promise.all([
    db.select().from(stages).where(eq(stages.agentId, agent.id)).orderBy(asc(stages.position)),
    db.select().from(leadFields).where(eq(leadFields.agentId, agent.id)).orderBy(asc(leadFields.position)),
  ]);
  try {
    const completion = await deps.model.complete({
      key: decryptSecret(agent.openrouterKey!, deps.key, keyAad(agent.id)),
      model: agent.model, temperature: '0', maxTokens: 2200,
      messages: [
        { role: 'system', content: crmPrompt(funnel, fieldRows) },
        { role: 'user', content: JSON.stringify({
          previousAnalysis: { summary: session.crmSummary, stageId: session.stageId,
            payment: { state: 'unknown', reason: null } },
          profile: session.crmProfile,
          fields: session.fields.map(({ id, value }) => ({ fieldId: id, value })),
          contact: { name: session.crmProfile.name ?? null, phone: session.phone },
          history,
        }) },
      ],
    });
    const analysis = parseCrmAnalysis(completion.text, history, fieldRows);
    // A rehearsal has no Kaspi payment; only a confident paid claim in the chat moves it to the sale stage.
    const target = resolveCrmStage(funnel, analysis.confidence >= 65 ? analysis.stageId : null,
      { paid: analysis.payment?.state === 'paid' && analysis.confidence >= 65, currentStageId: session.stageId });
    const checkout = analysis.checkout?.messageId === currentId && analysis.confidence >= 85
      ? { method: analysis.checkout.method, amount: analysis.checkout.amount,
          status: session.phone ? 'would_create' as const : 'blocked_no_phone' as const }
      : null;
    return {
      stage: target && target.id !== session.stageId ? { id: target.id, name: target.name } : null,
      fields: Object.entries(analysis.fields).map(([id, value]) => ({
        id, name: fieldRows.find((field) => field.id === id)!.name, value,
      })),
      summary: analysis.summary,
      profile: { ...session.crmProfile, ...analysis.profile },
      checkout,
      error: null,
    };
  } catch {
    return { stage: null, fields: [], summary: session.crmSummary ?? '',
      profile: session.crmProfile, checkout: null,
      error: 'Не удалось завершить ИИ-разбор CRM. Попробуйте ещё раз.',
    };
  }
}
