import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { money } from '@/components/drafts/cost';
import { Card, CardHead, Segmented } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { PERIODS } from '@/lib/periods';
import { useAgent } from '@/store/agent';
import type {
  AgentResponseMode,
  AiModel,
  AiSettings,
  AiTestContact,
  AiTurn,
  AiUsage,
  AiUsagePeriod,
} from '@/types';
import {
  changeResponseMode,
  initialResponseModeDraft,
  persistedResponseModeWarning,
  responseModeDraftDirty,
  responseModeSaveDecision,
  testContactLabel,
} from './agent-response-mode';

/**
 * Модель, которой отвечает агент, чем это оплачивается и что бы он ответил.
 *
 * The agent's character — what it says and how — moved to «Обучение»: a set of rules the
 * owner writes or approves in a coaching chat, not a paragraph on this screen. What stays
 * here is the machinery underneath it: the model, the key that pays for it, and a sandbox
 * to try a real turn. Facts still come from the knowledge base and from nowhere else — a
 * rule that promises something the base does not know sends the agent to a person instead.
 */

const control: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
};

const label: CSSProperties = { fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 5 };

const hint: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-dim)',
  marginTop: 6,
  lineHeight: 1.45,
};

/** Mirrors `SANDBOX_LIMIT` in `server/src/api/ai.ts`. A WhatsApp message is far shorter than this. */
const SANDBOX_LIMIT = 4_000;

/** Where an owner gets the key the agent spends. */
const KEYS_URL = 'https://openrouter.ai/keys';

/**
 * Языки ответа, которые предлагает список.
 *
 * `auto` — ответ на языке клиента: у одного и того же бизнеса пишут и по-русски, и
 * по-казахски, и выбор языка за клиентом почти всегда правильный. Остальные — для случая,
 * когда компания отвечает только на одном языке независимо от того, на каком спросили.
 */
const LANGUAGES: { id: string; label: string }[] = [
  { id: 'auto', label: 'Язык клиента' },
  { id: 'ru', label: 'Русский' },
  { id: 'kk', label: 'Казахский' },
  { id: 'en', label: 'Английский' },
];

/**
 * Чем закончился бы ход, словами.
 *
 * Всё в сослагательном наклонении: в песочнице ничего из этого не произошло. Шесть исходов,
 * потому что «ответ не дошёл» и «ответ дошёл, но не записался» — разные вещи, и владелец,
 * который их путает, чинит не ту поломку.
 */
const OUTCOMES: Record<string, string> = {
  sent: 'Ответ ушёл бы клиенту',
  unrecorded: 'Ответ дошёл бы до клиента, но не записался бы в переписку',
  applied: 'Агент промолчал бы и только обновил бы карточку лида',
  handoff: 'Агент передал бы диалог человеку',
  failed: 'Ответ не дошёл бы до клиента',
  skipped: 'Агент не стал бы отвечать',
};

const outcomeLabel = (outcome: string) => OUTCOMES[outcome] ?? 'Ход завершился неизвестно чем';

/** Handoff and failure are the two an owner has to look at; the rest are ordinary. */
const outcomeColor = (outcome: string) =>
  outcome === 'failed' || outcome === 'unrecorded'
    ? 'var(--danger)'
    : outcome === 'handoff' || outcome === 'skipped'
      ? 'var(--warn)'
      : 'var(--accent-2)';

interface Loaded {
  settings: AiSettings;
  models: AiModel[];
  testContacts: AiTestContact[];
}

export function AgentScreen() {
  const { agent, role } = useAgent();
  const owner = role === 'owner';

  const query = useApi<Loaded>(
    async (signal) => {
      const [settings, models, testContacts] = await Promise.all([
        api.getAiSettings(agent.id, signal),
        api.listAiModels(signal),
        owner ? api.listAiTestContacts(agent.id, signal) : Promise.resolve([]),
      ]);
      return { settings, models, testContacts };
    },
    [agent.id, owner],
  );

  return (
    <Async state={query} skeleton={<Skeleton height={320} />}>
      {(loaded) => (
        <AgentSettings
          // Keyed on the agent, so a form cannot show one agent's settings and save them
          // onto another when the URL moves under a provider that stays alive.
          key={agent.id}
          agentId={agent.id}
          owner={owner}
          loaded={loaded}
        />
      )}
    </Async>
  );
}

// Module scope, not nested inside AgentScreen: a component declared inside another's body
// gets a new identity every render, so React remounts it — wiping the model form being
// edited and the sandbox answer on screen.

/**
 * Настройки агента, каким их вернул сервер.
 *
 * Ответ сервера — единственный источник правды: каждая мутация отвечает всей строкой, и
 * состояние заменяется ею целиком. Собранная руками строка врала бы о том, что сохранилось:
 * температура округляется до двух знаков.
 */
function AgentSettings({
  agentId,
  owner,
  loaded,
}: {
  agentId: string;
  owner: boolean;
  loaded: Loaded;
}) {
  const [settings, setSettings] = useState<AiSettings>(loaded.settings);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ResponseModeCard
        agentId={agentId}
        owner={owner}
        settings={settings}
        contacts={loaded.testContacts}
        onSaved={setSettings}
      />
      <CrmAnalysisCard agentId={agentId} owner={owner} settings={settings} onSaved={setSettings} />
      <RulesPointerCard agentId={agentId} />
      <ModelCard
        agentId={agentId}
        owner={owner}
        models={loaded.models}
        settings={settings}
        onSaved={setSettings}
      />
      {/* Прямо под выбором модели: решение принимают здесь, и цена нужна здесь же. */}
      <UsageCard agentId={agentId} models={loaded.models} />
      {owner && <KeyCard agentId={agentId} settings={settings} onSaved={setSettings} />}
      {owner && <SandboxCard agentId={agentId} settings={settings} />}
      {!owner && (
        <Card>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            Правила, модель и ключ меняет владелец компании. Выключить агента в отдельном
            диалоге может любой сотрудник — тумблер стоит в карточке диалога.
          </div>
        </Card>
      )}
    </div>
  );
}

function CrmAnalysisCard({agentId,owner,settings,onSaved}:{agentId:string;owner:boolean;settings:AiSettings;onSaved:(settings:AiSettings)=>void}) {
  const toast = useToast();
  const [saving,setSaving] = useState(false);
  async function change(mode: AiSettings['crmAnalysisMode']) {
    if (!owner || saving || mode === settings.crmAnalysisMode) return;
    setSaving(true);
    try { onSaved(await api.updateAiSettings(agentId,{crmAnalysisMode:mode})); toast.ok('Режим анализа сохранён'); }
    catch (error) { toast.fail(error); }
    finally { setSaving(false); }
  }
  return <Card>
    <CardHead title="Анализ воронки" gap={10} />
    <p style={{...hint,marginTop:0}}>Независимый анализ обновляет этапы и данные клиента, но не отправляет сообщения, счета и события в Meta. Для него нужен ключ ИИ.</p>
    <select style={{...control,maxWidth:360}} aria-label="Режим анализа воронки" value={settings.crmAnalysisMode} disabled={!owner || saving} onChange={(event)=>void change(event.target.value as AiSettings['crmAnalysisMode'])}>
      <option value="follow_ai">По режиму AI</option>
      <option value="independent">Независимо от автоответов</option>
    </select>
  </Card>;
}

/**
 * Explicit response scope. Test mode carries one retained contact; live mode has a second
 * confirmation step because its effects reach every eligible conversation immediately.
 */
function ResponseModeCard({
  agentId,
  owner,
  settings,
  contacts,
  onSaved,
}: {
  agentId: string;
  owner: boolean;
  settings: AiSettings;
  contacts: AiTestContact[];
  onSaved: (settings: AiSettings) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => initialResponseModeDraft(settings));
  const [saving, setSaving] = useState(false);
  const [confirmingLive, setConfirmingLive] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  const selected = contacts.find((contact) => contact.id === draft.testContactId)
    ?? (settings.testContact?.id === draft.testContactId ? settings.testContact : null);
  const dirty = responseModeDraftDirty(draft, settings);
  const missingKey = draft.responseMode !== 'off' && !settings.keySet;
  const persistedWarning = persistedResponseModeWarning(settings);

  function chooseMode(responseMode: AgentResponseMode) {
    setDraft((current) => changeResponseMode(current, responseMode));
    setConfirmingLive(false);
    setValidation(null);
  }

  async function persist(liveConfirmed: boolean) {
    const decision = responseModeSaveDecision(draft, liveConfirmed);
    if (decision.kind === 'blocked') {
      setValidation('Выберите одного клиента для тестового режима.');
      return;
    }
    if (decision.kind === 'confirm_live') {
      setConfirmingLive(true);
      return;
    }
    if (missingKey || saving) return;

    setSaving(true);
    try {
      const saved = await api.updateAiSettings(agentId, decision.body);
      onSaved(saved);
      setDraft(initialResponseModeDraft(saved));
      setConfirmingLive(false);
      setValidation(null);
      toast.ok('Режим сохранён');
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHead title="Ответы в WhatsApp" gap={10} />
      <div style={{ ...hint, marginTop: 0 }}>
        Выберите, кому агент может отвечать и для кого применять автоматические изменения в CRM.
        В отдельном диалоге его по-прежнему можно выключить отдельно.
      </div>

      {owner ? (
        <div style={{ marginTop: 12 }}>
          <Segmented
            items={[
              { id: 'off', label: 'Выключен' },
              { id: 'test', label: 'Тест' },
              { id: 'live', label: 'Для всех' },
            ]}
            value={draft.responseMode}
            onChange={chooseMode}
            size="lg"
          />
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 650 }}>
          {draft.responseMode === 'off'
            ? 'Выключен'
            : draft.responseMode === 'test'
              ? 'Тест'
              : 'Для всех'}
        </div>
      )}

      {persistedWarning && (
        <div role="alert" style={{ ...hint, color: 'var(--danger)' }}>
          {owner
            ? persistedWarning
            : 'Тестовый клиент больше недоступен. Попросите владельца выбрать другого клиента.'}
        </div>
      )}

      {draft.responseMode === 'test' && (
        <div style={{ marginTop: 14, maxWidth: 520 }}>
          <div style={label}>Тестовый клиент</div>
          {owner ? (
            <select
              style={control}
              value={draft.testContactId ?? ''}
              disabled={saving || contacts.length === 0}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  testContactId: event.target.value || null,
                }));
                setValidation(null);
              }}
            >
              <option value="">Выберите клиента</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {testContactLabel(contact)}
                </option>
              ))}
            </select>
          ) : selected ? (
            <div style={{ fontSize: 13 }}>{testContactLabel(selected)}</div>
          ) : null}
          {selected && owner && (
            <div style={{ ...hint, color: 'var(--accent-2)' }}>
              Активный тестовый клиент: {testContactLabel(selected)}
            </div>
          )}
          {contacts.length === 0 && owner && (
            <div style={{ ...hint, color: 'var(--warn)' }}>
              Сначала дождитесь сообщения хотя бы от одного клиента — после этого его можно
              выбрать здесь.
            </div>
          )}
        </div>
      )}

      {owner && missingKey && (
        <div style={{ ...hint, color: 'var(--warn)' }}>
          Сначала добавьте ключ OpenRouter — ниже на этом экране.
        </div>
      )}
      {owner && validation && (
        <div role="alert" style={{ ...hint, color: 'var(--danger)' }}>{validation}</div>
      )}

      {owner && confirmingLive && (
        <div
          style={{
            marginTop: 12,
            padding: '11px 12px',
            border: '1px solid var(--warn)',
            borderRadius: 8,
            background: 'var(--sunken)',
          }}
        >
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Агент начнёт отвечать и применять изменения CRM во всех подходящих диалогах.
            Подтвердите включение для всех клиентов.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn" disabled={saving} onClick={() => void persist(true)}>
              {saving ? 'Сохраняем…' : 'Подтвердить и включить'}
            </button>
            <button type="button" className="btn" disabled={saving} onClick={() => setConfirmingLive(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {owner && !confirmingLive && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            disabled={!dirty || saving || missingKey}
            onClick={() => void persist(false)}
          >
            {saving ? 'Сохраняем…' : 'Сохранить режим'}
          </button>
        </div>
      )}
    </Card>
  );
}

/**
 * Где теперь живёт характер агента.
 *
 * The free-text instructions field is gone — a rule is switchable and orderable on its own,
 * a paragraph is not. This card is the one line that sends an owner looking for it to where
 * it actually is now.
 */
function RulesPointerCard({ agentId }: { agentId: string }) {
  return (
    <Card>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-3)' }}>
        Характер агента задаётся правилами в разделе «
        <Link to={`/a/${agentId}/training?tab=replies`} style={{ color: 'var(--accent)' }}>
          Обучение агента
        </Link>
        ».
      </div>
    </Card>
  );
}

/** Модель, температура и язык ответа — одной формой, потому что меняют их вместе. */
function ModelCard({
  agentId,
  owner,
  models,
  settings,
  onSaved,
}: {
  agentId: string;
  owner: boolean;
  models: AiModel[];
  settings: AiSettings;
  onSaved: (settings: AiSettings) => void;
}) {
  const toast = useToast();
  const [model, setModel] = useState(settings.model);
  // Held as text, not as a number: an input the person is halfway through clearing has no
  // number in it, and a state that insisted on one would put a 0 back under the cursor.
  const [temperature, setTemperature] = useState(settings.temperature.toFixed(2));
  const [language, setLanguage] = useState(settings.replyLanguage);
  const [saving, setSaving] = useState(false);

  const parsed = Number(temperature);
  const validTemperature = temperature.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 2;
  const dirty =
    model !== settings.model ||
    language !== settings.replyLanguage ||
    (validTemperature && parsed !== settings.temperature);

  const chosen = models.find((item) => item.id === model);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!validTemperature) return;

    setSaving(true);
    try {
      const saved = await api.updateAiSettings(agentId, {
        model,
        temperature: parsed,
        replyLanguage: language,
      });
      onSaved(saved);
      setModel(saved.model);
      setTemperature(saved.temperature.toFixed(2));
      setLanguage(saved.replyLanguage);
      toast.ok('Сохранено');
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHead title="Модель" gap={12} />

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px', minWidth: 220 }}>
            <div style={label}>Модель</div>
            <select
              style={control}
              value={model}
              disabled={!owner}
              onChange={(e) => setModel(e.target.value)}
            >
              {/* Модель, которой больше нет в списке, всё равно показывается своей: иначе
                  список молча выбрал бы за владельца другую. */}
              {!chosen && <option value={model}>{model}</option>}
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <div style={hint}>{chosen?.description ?? 'Эта модель больше не предлагается.'}</div>
          </div>

          <div style={{ flex: '0 0 130px' }}>
            <div style={label}>Температура</div>
            <input
              style={control}
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              disabled={!owner}
              onChange={(e) => setTemperature(e.target.value)}
            />
            <div style={{ ...hint, color: validTemperature ? undefined : 'var(--danger)' }}>
              {validTemperature
                ? 'Ниже — ответы предсказуемее и однообразнее, выше — свободнее. 0.3 хватает почти всем.'
                : 'Число от 0 до 2.'}
            </div>
          </div>

          <div style={{ flex: '0 0 170px' }}>
            <div style={label}>Язык ответа</div>
            <select
              style={control}
              value={language}
              disabled={!owner}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {/* Как и с моделью: язык, которого нет в списке, показывается как есть. */}
              {!LANGUAGES.some((item) => item.id === language) && (
                <option value={language}>{language}</option>
              )}
              {LANGUAGES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <div style={hint}>«Язык клиента» — отвечает на том, на котором спросили.</div>
          </div>
        </div>

        {owner && (
          <div style={{ marginTop: 12 }}>
            <button type="submit" className="btn" disabled={!dirty || saving || !validTemperature}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

/* ── Расход ──────────────────────────────────────────────────────────────── */

const count = (value: number) => value.toLocaleString('ru-RU');

/** Одно число с подписью. Плитками, потому что читают их взглядом, а не по строкам. */
function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ minWidth: 96 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{label}</div>
      <div
        className="mono"
        style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px', marginTop: 4, color }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Во что обошлись ответы агента — то, ради чего выбор модели вообще можно сравнить.
 *
 * Период выбирается, а не подразумевается, и назван словами: «за последние 7 дней» — это
 * ответ, а «7» в углу — загадка. Ходов за период не было — так и написано; строка нулей
 * читалась бы как факт о модели, а у владельца, который агента ещё не включал, никакого
 * факта о модели нет.
 *
 * Свой запрос, а не часть загрузки экрана: смена периода не должна гасить недописанный
 * текст в песочнице и её ответ.
 */
function UsageCard({ agentId, models }: { agentId: string; models: AiModel[] }) {
  const [period, setPeriod] = useState<AiUsagePeriod>('week');
  const query = useApi<AiUsage>((signal) => api.getAiUsage(agentId, period, signal), [
    agentId,
    period,
  ]);

  const chosen = PERIODS.find((item) => item.id === period)!;
  // Модель, которой больше нет в списке, показывается своим идентификатором: журнал хранит
  // то, что работало, и переименовывать это задним числом нечем.
  const modelLabel = (id: string) => models.find((item) => item.id === id)?.label ?? id;

  return (
    <Card>
      <CardHead
        title="Расход"
        gap={12}
        right={
          <Segmented
            items={PERIODS.map((item) => ({ id: item.id, label: item.label }))}
            value={period}
            onChange={setPeriod}
            size="sm"
          />
        }
      />

      <Async state={query} skeleton={<Skeleton height={96} />} compactError>
        {(usage) => (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {chosen.plainly}, с{' '}
              {new Date(usage.since).toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'long',
              })}
              .
            </div>

            {usage.total === null ? (
              <EmptyState>
                За этот период агент не отвечал — считать нечего.
                <br />
                Расход появляется здесь после первого ответа клиенту или запуска песочницы.
              </EmptyState>
            ) : (
              <>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '16px 28px',
                    marginTop: 14,
                  }}
                >
                  <Stat label="Ходов" value={count(usage.total.turns)} />
                  <Stat
                    label="Ушло клиенту"
                    value={count(usage.total.sent)}
                    color="var(--accent-2)"
                  />
                  <Stat
                    label="Передано человеку"
                    value={count(usage.total.handoff)}
                    color={usage.total.handoff > 0 ? 'var(--warn)' : undefined}
                  />
                  <Stat
                    label="Не дошло"
                    value={count(usage.total.failed)}
                    color={usage.total.failed > 0 ? 'var(--danger)' : undefined}
                  />
                  <Stat
                    label="Токенов"
                    value={count(usage.total.promptTokens + usage.total.completionTokens)}
                  />
                  <Stat label="Потрачено" value={money(usage.total.cost)} />
                </div>

                {/* По моделям — ради сравнения той, на которой сидят, с той, с которой
                    ушли. Если модель за период была одна, сравнивать не с чем: таблица из
                    одной строки повторила бы плитки выше, и вместо неё — строка о том, чьи
                    это цифры. Не назвать модель нельзя: плитки сами по себе молчат о том,
                    к чему относятся. */}
                {usage.byModel.length === 1 && (
                  <div style={{ ...hint, marginTop: 12 }}>
                    Все ходы за период — на модели {modelLabel(usage.byModel[0]!.model)}.
                  </div>
                )}
                {usage.byModel.length > 1 && (
                  <div style={{ marginTop: 18 }}>
                    <div style={{ ...label, marginBottom: 8 }}>По моделям</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>
                              Модель
                            </th>
                            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Ходов</th>
                            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Ушло</th>
                            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Человеку</th>
                            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Не дошло</th>
                            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Токенов</th>
                            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Потрачено</th>
                          </tr>
                        </thead>
                        <tbody>
                          {usage.byModel.map((row) => (
                            <tr
                              key={row.model}
                              style={{ borderTop: '1px solid var(--line-soft)', textAlign: 'right' }}
                            >
                              <td style={{ textAlign: 'left', padding: '8px' }}>
                                {modelLabel(row.model)}
                              </td>
                              <td className="mono" style={{ padding: '8px' }}>
                                {count(row.turns)}
                              </td>
                              <td className="mono" style={{ padding: '8px' }}>
                                {count(row.sent)}
                              </td>
                              <td className="mono" style={{ padding: '8px' }}>
                                {count(row.handoff)}
                              </td>
                              <td className="mono" style={{ padding: '8px' }}>
                                {count(row.failed)}
                              </td>
                              <td className="mono" style={{ padding: '8px' }}>
                                {count(row.promptTokens + row.completionTokens)}
                              </td>
                              <td className="mono" style={{ padding: '8px' }}>
                                {money(row.cost)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div style={hint}>
                  Это то, что OpenRouter выставил за вызовы модели, в долларах. Сюда попадают
                  и запуски песочницы, и повтор после негодного ответа — два вызова и один
                  счёт. Модель, которая цену не сообщает, записывается нулём: ход был, а
                  строка стоимости пустая. Точный счёт — в аккаунте OpenRouter.
                </div>
              </>
            )}
          </>
        )}
      </Async>
    </Card>
  );
}

/**
 * Ключ OpenRouter — тем же путём, что и токен WhatsApp.
 *
 * Ключ уходит на сервер и обратно не возвращается: экран знает только, есть он или нет.
 * Расход по модели — в карточке «Расход» выше; точный счёт — в аккаунте OpenRouter.
 */
function KeyCard({
  agentId,
  settings,
  onSaved,
}: {
  agentId: string;
  settings: AiSettings;
  onSaved: (settings: AiSettings) => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (key.trim() === '') return;

    setSaving(true);
    try {
      onSaved(await api.updateAiSettings(agentId, { openrouterKey: key.trim() }));
      // Очищается только на успехе: ключ, который сервер не принял, лучше оставить на
      // экране, чтобы его поправили, а не искали заново.
      setKey('');
      toast.ok('Ключ сохранён');
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm('Удалить ключ? Без него агент не сможет отвечать клиентам.')) return;

    setSaving(true);
    try {
      // Сервер откажет, если агент включён, — и скажет выключить его сначала. Это и есть
      // правильный порядок: агент без ключа молча пропускает каждое сообщение.
      onSaved(await api.updateAiSettings(agentId, { openrouterKey: null }));
      toast.ok('Ключ удалён');
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHead
          title="Ключ OpenRouter"
          gap={10}
          right={
            <span
              style={{
                fontSize: 11.5,
                color: settings.keySet ? 'var(--accent-2)' : 'var(--text-dim)',
              }}
            >
              {settings.keySet ? 'Ключ сохранён' : 'Ключа нет'}
            </span>
          }
        />

        <div style={{ ...hint, marginTop: 0 }}>
          Ключ берётся на{' '}
          <a href={KEYS_URL} target="_blank" rel="noreferrer">
            openrouter.ai/keys
          </a>
          . Ответы моделей оплачиваются с вашего счёта в OpenRouter. Ключ хранится в
          зашифрованном виде и обратно не показывается.
        </div>

        <input
          style={{ ...control, maxWidth: 460, marginTop: 10 }}
          type="password"
          value={key}
          autoComplete="off"
          placeholder={settings.keySet ? 'Введите новый ключ, чтобы заменить' : 'sk-or-…'}
          onChange={(e) => setKey(e.target.value)}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="submit" className="btn" disabled={saving || key.trim() === ''}>
            {saving ? 'Сохраняем…' : settings.keySet ? 'Заменить ключ' : 'Сохранить ключ'}
          </button>
          {settings.keySet && (
            <button type="button" className="btn" disabled={saving} onClick={remove}>
              Удалить ключ
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

/**
 * Песочница: один настоящий ход агента, который никуда не уходит.
 *
 * Кнопка блокируется на время хода. Ходов на весь сервер разрешено немного — они держат
 * соединение с базой, пока модель думает, — и владелец, нажавший «Проверить» пять раз
 * подряд, получил бы четыре отказа вместо одного ответа.
 */
function SandboxCard({ agentId, settings }: { agentId: string; settings: AiSettings }) {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [turn, setTurn] = useState<AiTurn | null>(null);
  // Показывается прямо в карточке, а не только всплывашкой: «Песочница занята» — это
  // указание подождать несколько секунд, и оно должно оставаться на экране, пока ждут.
  const [failure, setFailure] = useState<string | null>(null);

  const tooLong = text.length > SANDBOX_LIMIT;
  const ready = text.trim() !== '' && !tooLong && settings.keySet;

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!ready || running) return;

    setRunning(true);
    setFailure(null);
    try {
      setTurn(await api.runAiSandbox(agentId, text));
    } catch (error) {
      // Сообщение сервера точнее любого нашего: и «Песочница занята», и «сначала
      // подключите номер WhatsApp» — это ответы на вопрос владельца, а не сбои.
      setTurn(null);
      setFailure(api.humanError(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <form onSubmit={run}>
        <CardHead title="Проверить агента" gap={10} />

        <div style={{ ...hint, marginTop: 0 }}>
          Напишите то, что написал бы клиент. Агент отработает по-настоящему — с вашими
          правилами и вашей базой знаний, — но клиенту ничего не уйдёт, лид не изменится и
          в переписке ничего не останется. Ход оплачивается с вашего счёта в OpenRouter.
        </div>

        <textarea
          style={{ ...control, marginTop: 10, minHeight: 80, lineHeight: 1.5, resize: 'vertical' }}
          value={text}
          placeholder="Здравствуйте! Сколько стоит доставка в Астану?"
          onChange={(e) => setText(e.target.value)}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <button type="submit" className="btn" disabled={!ready || running}>
            {running ? 'Агент думает…' : 'Проверить'}
          </button>
          {!settings.keySet && (
            <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
              Сначала добавьте ключ OpenRouter.
            </span>
          )}
          {tooLong && (
            <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>
              Слишком длинно: {text.length} из {SANDBOX_LIMIT} символов.
            </span>
          )}
        </div>

        {failure !== null && (
          <div style={{ ...hint, color: 'var(--danger)' }}>{failure}</div>
        )}
      </form>

      {turn && <TurnResult turn={turn} />}
    </Card>
  );
}

/** Что агент сделал бы. Всё в сослагательном: ничего из этого не произошло. */
function TurnResult({ turn }: { turn: AiTurn }) {
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 650, color: outcomeColor(turn.outcome) }}>
        {outcomeLabel(turn.outcome)}
      </div>

      {turn.reply !== null ? (
        <div
          className="sunken-box"
          style={{
            padding: '10px 12px',
            marginTop: 8,
            fontSize: 12.5,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {turn.reply}
        </div>
      ) : (
        <div style={hint}>Ответа клиенту не было бы.</div>
      )}

      {/* Причина, а не флаг: «передал человеку» без «почему» — единственный ответ, с
          которым владельцу, правящему правила, нечего делать. */}
      {turn.handoff !== null && (
        <TurnRow title="Передал бы человеку" color="var(--warn)">
          {turn.handoff}
        </TurnRow>
      )}

      {turn.detail !== null && <TurnRow title="Подробности">{turn.detail}</TurnRow>}

      <TurnRow title="Разделы базы знаний">
        {turn.usedItems.length === 0 ? (
          // Названо вслух: ответ, построенный ни на чём, — это ровно тот случай, ради
          // которого база знаний и существует.
          <span style={{ color: 'var(--text-dim)' }}>
            ни одной — агент не нашёл в базе ничего подходящего
          </span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {turn.usedItems.map((item) => (
              <span
                key={item.id}
                className="ellipsis"
                style={{
                  maxWidth: 260,
                  fontSize: 11.5,
                  padding: '4px 9px',
                  borderRadius: 7,
                  background: 'var(--sunken-2)',
                  border: '1px solid var(--line)',
                  color: 'var(--text-3)',
                }}
              >
                {item.title}
              </span>
            ))}
          </div>
        )}
      </TurnRow>

      <TurnRow title="Стадия лида">
        {turn.stageName ?? <span style={{ color: 'var(--text-dim)' }}>не менялась бы</span>}
      </TurnRow>

      <TurnRow title="Поля лида">
        {turn.fields.length === 0 ? (
          <span style={{ color: 'var(--text-dim)' }}>ничего не заполнил бы</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {turn.fields.map((field) => (
              <div key={field.id}>
                <span style={{ color: 'var(--text-dim)' }}>{field.name}: </span>
                {field.value}
              </div>
            ))}
          </div>
        )}
      </TurnRow>
    </div>
  );
}

function TurnRow({
  title,
  color,
  children,
}: {
  title: string;
  color?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...label, marginBottom: 4, color: color ?? 'var(--text-dim)' }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-3)' }}>{children}</div>
    </div>
  );
}
