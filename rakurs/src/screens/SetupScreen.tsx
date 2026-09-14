/**
 * «Запуск» — семь этапов от пустого кабинета до работающей продажи, каждый по шагам.
 *
 * The section exists because everything the owner has to do to start lives in a different
 * screen — the number in «Интеграции», the funnel in «Настройках», the key in «Агенте» —
 * and nothing tells them the order, or that they are half-done. Here the order is the
 * screen, and every state comes from the cabinet's own data rather than from a checkbox:
 * a token that expired last night takes its step back to «наполовину» on the next reload.
 *
 * The heavy step — WhatsApp — is written out in `components/setup/WhatsappGuide.tsx`,
 * beside the rest of the guides. This file is the checklist and its arithmetic.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import {
  AgentGuide,
  CapiGuide,
  FunnelGuide,
  InboxGuide,
  KnowledgeGuide,
  StatsGuide,
} from '@/components/setup/guides';
import { WhatsappGuide } from '@/components/setup/WhatsappGuide';
import { Card } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import {
  setupProgress,
  setupStatuses,
  whatsappGuideDone,
  whatsappSetupPath,
  type SetupFacts,
  type SetupState,
  type SetupStepId,
  type SetupStatus,
} from '@/lib/setup';
import { useAgent } from '@/store/agent';
import type { WebhookSetup } from '@/types';

interface Loaded {
  facts: SetupFacts;
  /** Владельцу — значения для вебхука; участнику `null`, это общий с Meta секрет. */
  setup: WebhookSetup | null;
}

export function SetupScreen() {
  const { agent, role } = useAgent();
  const owner = role === 'owner';

  const query = useApi<Loaded>(
    async (signal) => {
      const [numbers, conversations, stages, leadFields, knowledgeItems, ai, capi] =
        await Promise.all([
          api.listWhatsappNumbers(agent.id, signal),
          api.listConversations(agent.id, signal),
          api.listStages(agent.id, signal),
          api.listLeadFields(agent.id, signal),
          api.listKbNotes(agent.id, {}, signal),
          api.getAiSettings(agent.id, signal),
          api.getCapiSettings(agent.id, signal),
        ]);

      return {
        facts: {
          numbers,
          conversations: conversations.length,
          stages: stages.length,
          leadFields: leadFields.length,
          knowledgeItems: knowledgeItems.length,
          ai,
          capi,
        },
        setup: owner ? await api.getWebhookSetup(agent.id, signal) : null,
      };
    },
    [agent.id, owner],
  );

  return (
    <Async state={query} skeleton={<Skeleton height={320} />}>
      {/* Keyed on the agent: the open step is «первый незавершённый у этого агента», and
          a switch of agents is a different checklist, not this one with new numbers. */}
      {(loaded) => <Checklist key={agent.id} loaded={loaded} owner={owner} />}
    </Async>
  );
}

/* ── Этапы ─────────────────────────────────────────────────────────────── */

interface StepDef {
  id: SetupStepId;
  title: string;
  /** Зачем этот этап нужен — одна строка, читается до раскрытия шагов. */
  why: string;
  /** Раздел кабинета, где этап делается. Пусто у этапа, который делается в Meta. */
  section?: { to: string; label: string };
  /** Этап, без которого кабинет всё равно работает. */
  optional?: boolean;
}

const STEPS: StepDef[] = [
  {
    id: 'whatsapp',
    title: 'Подключить номер WhatsApp',
    why: 'Без номера в кабинет не придёт ни одного сообщения: всё остальное держится на нём.',
    section: { to: '../integrations', label: 'Интеграции' },
  },
  {
    id: 'inbox',
    title: 'Принять первое сообщение и ответить',
    why: 'Единственная проверка, что настройка в Meta доведена до конца, а не выглядит доведённой.',
    section: { to: '../funnel', label: 'Воронка' },
  },
  {
    id: 'funnel',
    title: 'Настроить воронку под свою продажу',
    why: 'Стадии и поля лида решают, что кабинет будет считать продажей, а что — отказом.',
    section: { to: '../settings', label: 'Настройки' },
  },
  {
    id: 'knowledge',
    title: 'Наполнить базу знаний',
    why: 'То, чем агент отвечает клиентам. Пустая база — это агент, который зовёт человека на каждый вопрос.',
    section: { to: '../training?tab=knowledge', label: 'Обучение агента' },
  },
  {
    id: 'agent',
    title: 'Проверить и включить ИИ-агента',
    why: 'Ключ, правила характера в «Обучении», песочница — и только потом ответы живым клиентам.',
    section: { to: '../agent', label: 'Агент' },
  },
  {
    id: 'capi',
    title: 'Отправлять покупки в Meta',
    why: 'Нужно тем, кто ведёт рекламу Click-to-WhatsApp: реклама начинает искать похожих покупателей.',
    section: { to: '../integrations', label: 'Интеграции' },
    optional: true,
  },
  {
    id: 'stats',
    title: 'Научиться читать статистику',
    why: 'Три карточки отвечают на три разных вопроса, и у каждой своя честность за прошлое.',
    section: { to: '../stats', label: 'Статистика' },
  },
];

/* ── Чек-лист ──────────────────────────────────────────────────────────── */

function Checklist({ loaded, owner }: { loaded: Loaded; owner: boolean }) {
  const statuses = setupStatuses(loaded.facts);
  const progress = setupProgress(statuses);

  // Раскрыт тот этап, на котором кабинет стоит. Дальше владелец открывает и закрывает
  // сам, поэтому это начальное значение, а не вычисляемое на каждый рендер.
  const [open, setOpen] = useState<SetupStepId | null>(
    () => STEPS.find((step) => statuses[step.id].state !== 'done')?.id ?? null,
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ProgressCard done={progress.done} total={progress.total} owner={owner} />
      {STEPS.map((step, index) => (
        <StepCard
          key={step.id}
          n={index + 1}
          step={step}
          status={statuses[step.id]}
          open={open === step.id}
          onToggle={() => setOpen((current) => (current === step.id ? null : step.id))}
          setup={loaded.setup}
          facts={loaded.facts}
        />
      ))}
    </div>
  );
}

function ProgressCard({ done, total, owner }: { done: number; total: number; owner: boolean }) {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 650 }}>Готовность кабинета</div>
        <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-4)' }}>
          {done} из {total}
        </div>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 6,
          background: 'var(--track)',
          overflow: 'hidden',
          marginTop: 12,
        }}
      >
        <div
          style={{
            height: '100%',
            borderRadius: 6,
            background: 'var(--accent-2)',
            width: `${Math.round((done / total) * 100)}%`,
          }}
        />
      </div>
      <div className="pretty" style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 10, lineHeight: 1.55 }}>
        {done === total
          ? 'Все этапы пройдены. Список остаётся здесь как проверка: если номер отвалится или у агента кончится ключ, этап вернётся в «наполовину».'
          : 'Этапы считаются по данным кабинета, а не по галочкам: истёкший токен или выключенный агент сами вернут этап назад.'}
        {!owner && ' Часть шагов доступна только владельцу компании — они помечены внутри.'}
      </div>
    </Card>
  );
}

const STATE_LOOK: Record<SetupState, { label: string; fg: string; bg: string }> = {
  done: { label: 'Готово', fg: 'var(--accent)', bg: 'var(--accent-a14)' },
  partial: { label: 'Наполовину', fg: 'var(--warn)', bg: 'var(--warn-a14)' },
  todo: { label: 'Не начато', fg: 'var(--text-muted)', bg: 'var(--seg)' },
};

function StepCard({
  n,
  step,
  status,
  open,
  onToggle,
  setup,
  facts,
}: {
  n: number;
  step: StepDef;
  status: SetupStatus;
  open: boolean;
  onToggle: () => void;
  setup: WebhookSetup | null;
  facts: SetupFacts;
}) {
  const look = STATE_LOOK[status.state];

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          className="mono"
          style={{
            width: 26,
            height: 26,
            flex: '0 0 26px',
            borderRadius: 8,
            background: status.state === 'done' ? 'var(--accent-a14)' : 'var(--seg)',
            color: status.state === 'done' ? 'var(--accent)' : 'var(--text-4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {status.state === 'done' ? '✓' : n}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13.5, fontWeight: 650 }}>{step.title}</div>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                padding: '3px 8px',
                borderRadius: 6,
                background: look.bg,
                color: look.fg,
                whiteSpace: 'nowrap',
              }}
            >
              {look.label}
            </span>
            {step.optional && (
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>необязательно</span>
            )}
          </div>

          <div className="pretty" style={{ fontSize: 12, color: 'var(--text-4)', lineHeight: 1.55, marginTop: 5 }}>
            {step.why}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 5 }}>{status.note}</div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10 }}>
            <button type="button" className="btn-sm" onClick={onToggle}>
              {open ? 'Свернуть шаги' : 'Показать шаги'}
            </button>
            {step.section && (
              <Link to={step.section.to} style={{ fontSize: 11.5, fontWeight: 600 }}>
                Открыть «{step.section.label}»
              </Link>
            )}
          </div>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          <StepGuide id={step.id} setup={setup} facts={facts} />
        </div>
      )}
    </Card>
  );
}

/**
 * Какие шаги показать под этапом.
 *
 * A switch rather than a lookup table: the WhatsApp guide is the only one that needs the
 * webhook values, and a table would have to type every guide as taking them.
 */
function StepGuide({
  id,
  setup,
  facts,
}: {
  id: SetupStepId;
  setup: WebhookSetup | null;
  facts: SetupFacts;
}) {
  switch (id) {
    case 'whatsapp':
      return (
        <WhatsappGuide
          setup={setup}
          done={whatsappGuideDone(facts)}
          path={whatsappSetupPath(facts.numbers)}
        />
      );
    case 'inbox':
      return <InboxGuide />;
    case 'funnel':
      return <FunnelGuide />;
    case 'knowledge':
      return <KnowledgeGuide />;
    case 'agent':
      return <AgentGuide />;
    case 'capi':
      return <CapiGuide />;
    case 'stats':
      return <StatsGuide />;
  }
}
