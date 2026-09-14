/**
 * Подключение номера WhatsApp — восемь действий от чистой SIM-карты до первого ответа.
 *
 * Every step is one action written as the click path through somebody else's interface and
 * nothing more: the owner reading this has Meta open in the other window and needs to know
 * what to press. Explanation is spent only on the three failures that stay invisible until
 * a customer writes — a token that dies in 24 hours, a webhook saved without subscribing to
 * `messages`, and a token issued by a different Meta application than the server runs on —
 * and each of them is one line, at the step where the mistake is made.
 *
 * Steps the cabinet can see finished — `done`, computed in `lib/setup.ts` — are left out,
 * because an owner whose number already answers is looking for the step still missing, not
 * for the ones done last week. Nothing is deleted: «Показать все шаги» brings them back,
 * and the numbers never shift, so «сделайте шаг 6» keeps pointing at step 6.
 *
 * `docs/whatsapp-setup.md` walks the same path in prose for whoever prefers reading a file.
 */
import { useState, type ReactElement } from 'react';
import { Bullets, Copy, Note, Out, Path, Step, Steps, Troubles } from './Guide';
import type { WhatsappSetupPath } from '@/lib/setup';
import type { WebhookSetup } from '@/types';

const APPS_URL = 'https://developers.facebook.com/apps/';
const SYSTEM_USERS_URL = 'https://business.facebook.com/settings/system-users';

/** Один общий пустой набор: «кабинет пока ничего не знает» — это не новый объект на рендер. */
const EMPTY: ReadonlySet<number> = new Set();

export function WhatsappGuide({
  setup,
  done,
  path = 'none',
}: {
  setup: WebhookSetup | null;
  /** Номера шагов, которые кабинет видит пройденными по своим данным. */
  done?: ReadonlySet<number>;
  /** Каким путём подключён номер: инструкция ниже написана только про путь через Meta. */
  path?: WhatsappSetupPath;
}) {
  const [showAll, setShowAll] = useState(false);
  const finished = done ?? EMPTY;

  // Номер с телефона: ни приложения в Meta, ни системного пользователя, ни вебхука вручную
  // здесь не было и не будет. Инструкция про них — не «остаток работы», а чужая дорога.
  if (path === 'phone') {
    return (
      <Note>
        Номер подключён с телефона — в Meta для него настраивать нечего. Если сообщения не
        идут, смотрите строку под номером в «Интеграциях»: кабинет пишет там, что именно
        случилось — телефон отвязали, не прошёл импорт истории или на телефоне отключили
        Business Platform.
      </Note>
    );
  }

  const steps: ReactElement<{ n: number }>[] = [
    <Step key={1} n={1} title="Создайте приложение Meta и возьмите отдельную SIM-карту">
      <Bullets
        items={[
          <>
            <Out href={APPS_URL}>developers.facebook.com/apps</Out> → <Path>Create app</Path> →
            тип <Path>Business</Path> → <Path>Add product</Path> → <Path>WhatsApp</Path>.
          </>,
          <>SIM-карта, которой не пользовались ни в WhatsApp, ни в WhatsApp Business.</>,
        ]}
      />
      <Note kind="danger">
        Номер уйдёт к бизнесу навсегда: обратно в обычный WhatsApp Meta его не вернёт.
      </Note>
      <Note kind="warn">
        Кабинет вам дал поставщик — приложение его: попросите добавить вас туда (роль
        Developer) и делайте шаги 2–5 в этом приложении. Токен из чужого приложения кабинет
        не примет.
      </Note>
    </Step>,

    <Step key={2} n={2} title="Добавьте номер: WhatsApp → API Setup → Add phone number">
      <Bullets
        items={[
          <>Впишите имя отправителя — его увидит клиент — и категорию бизнеса.</>,
          <>Впишите номер и введите код, который Meta пришлёт по SMS или звонком.</>,
        ]}
      />
    </Step>,

    <Step key={3} n={3} title="Скопируйте два ID с той же страницы API Setup">
      <Bullets
        items={[
          <>
            <b>Phone number ID</b> — под номером в списке <Path>From</Path>.
          </>,
          <>
            <b>WhatsApp Business Account ID</b> — там же, строкой ниже.
          </>,
        ]}
      />
      <div>Понадобятся на шаге 7. Секретом не являются — держите в блокноте.</div>
    </Step>,

    <Step key={4} n={4} title="Выпустите постоянный токен">
      <Bullets
        items={[
          <>
            <Out href={SYSTEM_USERS_URL}>Business settings → Users → System users</Out> →{' '}
            <Path>Add</Path> → создайте системного пользователя.
          </>,
          <>
            <Path>Assign assets</Path> → отметьте приложение и WhatsApp Business Account →
            полный контроль.
          </>,
          <>
            <Path>Generate new token</Path> → выберите это приложение → срок{' '}
            <Path>Never</Path>.
          </>,
          <>
            Отметьте права <Path>whatsapp_business_messaging</Path> и{' '}
            <Path>whatsapp_business_management</Path> → скопируйте токен.
          </>,
        ]}
      />
      <Note kind="warn">
        Токен показывается один раз. Тот, что лежит на странице <Path>API Setup</Path>, не
        подойдёт: он живёт 24 часа, и через сутки ответы клиентам перестанут уходить.
      </Note>
    </Step>,

    <Step key={5} n={5} title="Пропишите вебхук: WhatsApp → Configuration → Webhook → Edit">
      {setup ? (
        <>
          <div>
            Вставьте эти два значения в поля Meta и нажмите <Path>Verify and save</Path>:
          </div>
          <Copy label="Callback URL" value={setup.url} />
          <Copy label="Verify token" value={setup.verifyToken} />
        </>
      ) : (
        <Note>
          Значения для этого шага видны владельцу компании — попросите его выполнить шаг.
        </Note>
      )}
    </Step>,

    <Step
      key={6}
      n={6}
      title="Подпишитесь на messages: там же → Webhook fields → messages → Subscribe"
    >
      <Note kind="warn">
        Без этой подписки Meta примет вебхук и не пришлёт ни одного сообщения. Кабинет об
        этом не узнает — для него просто никто не пишет.
      </Note>
    </Step>,

    <Step key={7} n={7} title="Подключите номер в кабинете: Интеграции → «Отдельный номер»">
      <Bullets
        items={[
          <>Phone number ID и WhatsApp Business Account ID — из шага 3.</>,
          <>Токен доступа — из шага 4.</>,
          <>Нажмите «Подключить».</>,
        ]}
      />
    </Step>,

    <Step key={8} n={8} title="Проверьте живым сообщением">
      <Bullets
        items={[
          <>Напишите на подключённый номер с другого телефона.</>,
          <>В «Воронке» за несколько секунд появится карточка клиента.</>,
          <>Ответьте из кабинета — ответ придёт в WhatsApp.</>,
        ]}
      />
      <div>Дошло в обе стороны — подключение готово.</div>
    </Step>,
  ];

  const shown = showAll ? steps : steps.filter((step) => !finished.has(step.props.n));
  const hidden = steps.length - shown.length;

  return (
    <>
      {(hidden > 0 || showAll) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            marginBottom: 10,
          }}
        >
          <div
            className="pretty"
            style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.55 }}
          >
            {showAll
              ? 'Показаны все шаги, включая пройденные.'
              : 'Пройденные шаги скрыты. Номера остальных не менялись.'}
          </div>
          <button
            type="button"
            className="btn-sm"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? 'Скрыть пройденные' : 'Показать все шаги'}
          </button>
        </div>
      )}

      <Steps>
        {shown}

        <Note>
          Пока бизнес не верифицирован, номер отвечает только тем, кто есть в списке{' '}
          <Path>WhatsApp → API Setup → To</Path>, и не больше чем 250 собеседникам в сутки.
          Снимается верификацией бизнеса в Business Portfolio.
        </Note>

        <Troubles
          items={[
            {
              sign: 'Клиенты пишут, а в «Воронке» пусто',
              why: (
                <>
                  Не отмечено поле <Path>messages</Path> — шаг 6. Либо приложение не подписано
                  на WABA: об этом кабинет пишет красной строкой в списке номеров.
                </>
              ),
            },
            {
              sign: 'Meta приняла вебхук, сообщения всё равно не идут',
              why: (
                <>
                  Вебхук прописан в другом приложении Meta. Пропишите его в том, из которого
                  выпускали токен на шаге 4.
                </>
              ),
            },
            {
              sign: 'При подключении: «Meta не приняла эти данные»',
              why: <>Токен временный или с опечаткой. Нужен постоянный — шаг 4.</>,
            },
            {
              sign: 'Ответ не уходит: «Окно ответа закрыто»',
              why: (
                <>
                  С сообщения клиента прошло больше 24 часов. Ответить можно, когда он
                  напишет снова.
                </>
              ),
            },
            {
              sign: 'Ответ не уходит: ошибка про allowed list',
              why: (
                <>
                  Номер в тестовом режиме: добавьте получателя в <Path>API Setup → To</Path>{' '}
                  или верифицируйте бизнес.
                </>
              ),
            },
            {
              sign: 'Всё работало и внезапно перестало',
              why: (
                <>
                  Истёк токен. Кнопка «Обновить токен» рядом с номером — номер не удаляйте:
                  вместе с ним уйдут переписки и данные о рекламе, из которой пришли клиенты.
                </>
              ),
            },
          ]}
        />
      </Steps>
    </>
  );
}
