/**
 * Replays real customer conversations against the agent's production reply path and grades
 * how the agent talks.
 *
 * A developer tool, not a product feature. It never touches a production database: it seeds a
 * local database from an exported agent snapshot, then drives `runSimulatorTurn` — the same
 * code the cabinet's testing sandbox runs, CRM analysis included. A second model plays each
 * customer from a real conversation (their language, their questions, their city), and a third
 * grades the finished dialogue as a sales manager would.
 *
 * Usage (from `server/`):
 *
 *   EVAL_DATABASE_URL=postgres://rakurs:rakurs@localhost:55432/rakurs_eval \
 *   EVAL_CREDENTIALS_KEY_FILE=/path/credkey \
 *   npx tsx src/scripts/dialogue-eval.ts --snapshot agent.json --conversations conv.json \
 *     --count 12 --turns 8 --out report.md
 *
 * `agent.json` holds the agent row (with its sealed OpenRouter key), rules, stages, fields and
 * notes; `conv.json` holds conversations as `[{ id, msgs: [{ a, k, b }] }]`. Both are exported
 * by hand with psql; the key file holds the production `CREDENTIALS_KEY` that sealed the key.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createDb, type Db } from '../db/client.js';
import {
  accounts, agentRules, agents, aiSandboxSessions, stages,
} from '../db/schema.js';
import { runSimulatorTurn } from '../lib/ai/simulator.js';
import { createModelClient, type ChatMessage } from '../lib/ai/openrouter.js';
import { keyAad, type TurnDeps } from '../lib/ai/turn.js';
import { saveNote } from '../lib/knowledge/notes.js';
import { decryptSecret, encryptSecret } from '../lib/secret-box.js';
import { DEFAULT_STAGES } from '../lib/funnel.js';

interface Snapshot {
  agent: {
    name: string; timezone: string; model: string; temperature: string;
    reply_language: string; communication_style: string; openrouter_key: string; id: string;
  };
  rules: { category: string; text: string; enabled: boolean; origin: string; position: number }[] | null;
  stages: { name: string; color: string; kind: string; position: number; description: string;
    agent_goal?: string; auto_message: string | null }[];
  notes: { path: string; body: string }[] | null;
}

interface RealConversation { id: string; msgs: { a: string; k: string; b: string | null }[] }

interface Exchange { client: string; reply: string | null; stage: string | null; outcome: string; detail: string | null }

const { values: args } = parseArgs({
  options: {
    snapshot: { type: 'string' },
    conversations: { type: 'string' },
    count: { type: 'string', default: '10' },
    turns: { type: 'string', default: '8' },
    offset: { type: 'string', default: '0' },
    out: { type: 'string', default: 'dialogue-eval.md' },
    'actor-model': { type: 'string', default: 'openai/gpt-4.1-mini' },
    'judge-model': { type: 'string', default: 'openai/gpt-4.1' },
    concurrency: { type: 'string', default: '3' },
    // Seed stages exactly as exported, without the texts migration 0046 fills in.
    baseline: { type: 'boolean', default: false },
    // Answer with another model than the exported agent uses.
    model: { type: 'string' },
  },
});

// Actor and judge stay on OpenAI models: the run bills the agent's own OpenRouter key, and
// Claude as actor and judge cost more than every reply it graded.
const URL = process.env.EVAL_DATABASE_URL ?? 'postgres://rakurs:rakurs@localhost:55432/rakurs_eval';
const snapshot = JSON.parse(readFileSync(args.snapshot!, 'utf8')) as Snapshot;
const conversations = JSON.parse(readFileSync(args.conversations!, 'utf8')) as RealConversation[];
const prodKey = Buffer.from(readFileSync(process.env.EVAL_CREDENTIALS_KEY_FILE!, 'utf8').trim(), 'base64');
const openrouterKey = decryptSecret(snapshot.agent.openrouter_key, prodKey, keyAad(snapshot.agent.id));
const localKey = Buffer.alloc(32, 7);
const model = createModelClient();

/** Recreates the eval database from scratch so every run starts from the same agent. */
async function freshDb(): Promise<Db> {
  const admin = postgres(URL.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  const name = URL.slice(URL.lastIndexOf('/') + 1);
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const db = createDb(URL);
  await migrate(db, { migrationsFolder: 'drizzle' });
  return db;
}

/** The stage texts as they will stand after migration 0046, unless this is a baseline run. */
function stageTexts(stage: Snapshot['stages'][number]): { description: string; agentGoal: string } {
  const fallback = DEFAULT_STAGES.find((d) => d.name === stage.name.trim());
  if (args.baseline || !fallback) return { description: stage.description, agentGoal: stage.agent_goal ?? '' };
  return {
    description: stage.description.trim() === '' ? fallback.description : stage.description,
    agentGoal: stage.agent_goal?.trim() ? stage.agent_goal : fallback.agentGoal,
  };
}

async function seed(db: Db): Promise<{ accountId: string; agentId: string }> {
  const [account] = await db.insert(accounts).values({ name: 'eval' }).returning();
  const [agent] = await db.insert(agents).values({
    accountId: account!.id, name: snapshot.agent.name, timezone: snapshot.agent.timezone,
    model: args.model ?? snapshot.agent.model, temperature: snapshot.agent.temperature,
    replyLanguage: snapshot.agent.reply_language,
    communicationStyle: snapshot.agent.communication_style as never,
    aiEnabled: true, responseMode: 'test', crmAnalysisMode: 'independent',
  }).returning();
  await db.update(agents).set({
    openrouterKey: encryptSecret(openrouterKey, localKey, keyAad(agent!.id)),
  }).where(sql`id = ${agent!.id}`);
  for (const rule of snapshot.rules ?? []) {
    await db.insert(agentRules).values({ agentId: agent!.id, ...rule });
  }
  await db.insert(stages).values(snapshot.stages.map((stage) => ({
    agentId: agent!.id, name: stage.name, color: stage.color, kind: stage.kind,
    position: stage.position, autoMessage: null,
    ...stageTexts(stage),
  })));
  for (const note of snapshot.notes ?? []) {
    await db.transaction((tx) => saveNote(tx as unknown as Db, { agentId: agent!.id, path: note.path, body: note.body }));
  }
  return { accountId: account!.id, agentId: agent!.id };
}

async function ask(modelId: string, messages: ChatMessage[], temperature = '0.7'): Promise<string> {
  const completion = await model.complete({ key: openrouterKey, model: modelId, temperature,
    messages, timeoutMs: 120_000 });
  return completion.text;
}

function json<T>(text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(text.slice(start, end + 1)) as T;
}

/** The real conversation as the actor reads it: what this customer actually said and wanted. */
function realTranscript(conversation: RealConversation): string {
  return conversation.msgs.slice(0, 60).map((m) => {
    const who = m.a === 'client' ? 'КЛИЕНТ' : 'МЕНЕДЖЕР';
    const body = (m.b ?? '').trim();
    return `${who}: ${body === '' ? `[${m.k}]` : body.slice(0, 400)}`;
  }).join('\n');
}

const ACTOR_SYSTEM = `Ты играешь реального клиента, который пишет в WhatsApp компании, где делают печати (мөр).
Ниже настоящая переписка этого клиента с живым менеджером. Веди себя как этот клиент: тот же язык (казахский, русский или смесь), та же манера — коротко, разговорно, с опечатками, без заглавных и точек, если клиент так писал. Задавай те же вопросы и сообщай те же сведения (город, дизайн, текст печати), но реагируй на то, что тебе реально ответили сейчас, а не в старой переписке.
Картинки ты отправить не можешь — если клиент слал фото, опиши словами («вот такой дизайн хочу, круглый с гербом»).
Не помогай менеджеру: если он не ответил на вопрос — переспроси или вырази недовольство, как живой человек. Если на тебя давят оплатой раньше времени — реагируй как живой клиент.
Когда разговор естественно закончился (заказ оформлен и дошли до оплаты, клиент ушёл думать, или отказался) — верни done: true.
Ответ — только JSON: {"message": "текст клиента", "done": false}`;

async function clientMessage(conversation: RealConversation, dialogue: Exchange[]): Promise<{ message: string; done: boolean }> {
  const lines = dialogue.flatMap((turn) => [
    `КЛИЕНТ (ты): ${turn.client}`,
    `МЕНЕДЖЕР: ${turn.reply ?? '[менеджер не ответил]'}`,
  ]);
  const raw = await ask(args['actor-model']!, [
    { role: 'system', content: ACTOR_SYSTEM },
    { role: 'user', content: `НАСТОЯЩАЯ ПЕРЕПИСКА (образец клиента):\n${realTranscript(conversation)}\n\nТЕКУЩИЙ РАЗГОВОР С НОВЫМ МЕНЕДЖЕРОМ:\n${lines.length === 0 ? '(ещё не начат — напиши первое сообщение, как этот клиент начал)' : lines.join('\n')}\n\nНапиши следующее сообщение клиента.` },
  ]);
  return json(raw);
}

const JUDGE_SYSTEM = `Ты — руководитель отдела продаж. Оцени, как ИИ-менеджер компании по изготовлению печатей ведёт переписку в WhatsApp.
Хороший менеджер: здоровается и узнаёт, что нужно; выясняет потребность (какая печать, дизайн, текст, город); отвечает прямо на заданный вопрос (цена, сроки, доставка), а не уходит от него; предлагает решение; снимает сомнения; только когда клиент выбрал и готов — подтверждает заказ, итог и способ оплаты. Пишет коротко, по-человечески, на языке клиента, один вопрос за раз, не повторяет уже отвеченное.
Плохо: спрашивать «заказываете?»/про оплату/реквизиты до того, как клиент выбрал и сказал, что берёт; игнорировать вопрос клиента; отвечать шаблонно; путать язык; повторять вопросы; зря передавать человеку (handoff), когда ответ есть в базе; выдумывать факты.
Верни только JSON (булевы поля — true или false): {"score": 7, "pushyEarly": false, "ignoredQuestion": false, "wrongLanguage": false, "repeated": false, "needlessHandoff": false, "issues": [{"turn": номер хода, "problem": "кратко"}], "summary": "1-2 предложения"}`;

interface Verdict { score: number; pushyEarly: boolean; ignoredQuestion: boolean; wrongLanguage: boolean;
  repeated: boolean; needlessHandoff: boolean; issues: { turn: number; problem: string }[]; summary: string }

async function judge(dialogue: Exchange[]): Promise<Verdict> {
  const text = dialogue.map((turn, i) => `Ход ${i + 1}\nКЛИЕНТ: ${turn.client}\nМЕНЕДЖЕР: ${turn.reply ?? `[не ответил: ${turn.outcome}${turn.detail ? ` — ${turn.detail}` : ''}]`}\n(этап CRM: ${turn.stage ?? '—'})`).join('\n\n');
  return json(await ask(args['judge-model']!, [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: text },
  ], '0'));
}

async function play(db: Db, scope: { accountId: string; agentId: string }, conversation: RealConversation): Promise<{ dialogue: Exchange[]; verdict: Verdict }> {
  const deps = { model, key: localKey, crm: async () => false } as unknown as TurnDeps;
  const [session] = await db.insert(aiSandboxSessions).values({
    accountId: scope.accountId, agentId: scope.agentId, title: conversation.id, phone: '+77000000000',
  }).returning();
  const dialogue: Exchange[] = [];
  let revision = 0;
  for (let turn = 0; turn < Number(args.turns); turn += 1) {
    const next = await clientMessage(conversation, dialogue);
    if (next.done && turn > 0) break;
    if (next.message.trim() === '') break;
    const result = await runSimulatorTurn(db, deps, {
      agentId: scope.agentId, sessionId: session!.id, text: next.message, revision,
    });
    revision = result.revision;
    dialogue.push({ client: next.message, reply: result.reply, stage: result.stageName,
      outcome: result.outcome ?? '', detail: result.detail });
    if (result.handoff !== null || result.outcome === 'checkout') break;
  }
  return { dialogue, verdict: await judge(dialogue) };
}

async function main(): Promise<void> {
  const db = await freshDb();
  const scope = await seed(db);
  const chosen = conversations
    .filter((c) => c.msgs[0]?.a === 'client')
    .filter((c) => c.msgs.filter((m) => m.a === 'client' && (m.b ?? '').trim() !== '').length >= 2)
    .slice(Number(args.offset), Number(args.offset) + Number(args.count));
  const results: { id: string; dialogue: Exchange[]; verdict: Verdict | null; error?: string }[] = [];
  const queue = [...chosen];
  await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const played = await play(db, scope, c);
        results.push({ id: c.id, ...played });
        process.stdout.write(`${c.id.slice(0, 8)} score ${played.verdict.score}\n`);
      } catch (error) {
        results.push({ id: c.id, dialogue: [], verdict: null, error: String(error) });
        process.stdout.write(`${c.id.slice(0, 8)} error ${String(error).slice(0, 200)}\n`);
      }
    }
  }));

  const graded = results.filter((r) => r.verdict !== null);
  const count = (key: keyof Verdict) => graded.filter((r) => r.verdict![key] === true).length;
  const average = graded.reduce((sum, r) => sum + r.verdict!.score, 0) / Math.max(graded.length, 1);
  const report = [
    `# Dialogue eval — ${new Date().toISOString()}`,
    '',
    `Dialogues: ${graded.length}, average score ${average.toFixed(1)}; pushy early ${count('pushyEarly')}, ignored question ${count('ignoredQuestion')}, wrong language ${count('wrongLanguage')}, repeated ${count('repeated')}, needless handoff ${count('needlessHandoff')}.`,
    '',
    ...results.flatMap((r) => [
      `## ${r.id.slice(0, 8)} — ${r.verdict ? `score ${r.verdict.score}` : `error ${r.error}`}`,
      '',
      r.verdict ? `> ${r.verdict.summary}` : '',
      ...(r.verdict?.issues ?? []).map((issue) => `- turn ${issue.turn}: ${issue.problem}`),
      '',
      ...r.dialogue.flatMap((t, i) => [
        `**${i + 1}. Client:** ${t.client}`,
        `**Agent:** ${t.reply ?? `_(${t.outcome}${t.detail ? `: ${t.detail}` : ''})_`}  \`${t.stage ?? '—'}\``,
        '',
      ]),
    ]),
  ].join('\n');
  writeFileSync(args.out!, report);
  process.stdout.write(`average ${average.toFixed(1)} → ${args.out}\n`);
  process.exit(0);
}

await main();
