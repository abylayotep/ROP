/**
 * Подключение номера WhatsApp — весь путь, от чистой SIM-карты до первого ответа клиенту.
 *
 * This guide exists because the owner doing it has never opened Meta for Developers and
 * has no way to tell a step that failed from a step that quietly did nothing. Three
 * failures here are invisible until a customer writes and nobody answers: a temporary
 * token that dies in 24 hours, a webhook saved without subscribing to `messages`, and a
 * token issued by a different Meta application than the one this server is configured
 * with. Each of them is called out at the step where it is made, not in a footnote.
 *
 * `docs/whatsapp-setup.md` holds the same path in prose for whoever prefers reading a
 * file; the two are meant to say the same thing.
 */
import { Bullets, Copy, Note, Out, Path, Step, Steps, Troubles } from './Guide';
import type { WebhookSetup } from '@/types';

const APPS_URL = 'https://developers.facebook.com/apps/';
const BUSINESS_URL = 'https://business.facebook.com/';
const SYSTEM_USERS_URL = 'https://business.facebook.com/settings/system-users';

export function WhatsappGuide({ setup }: { setup: WebhookSetup | null }) {
  return (
    <Steps>
      <Step n={1} title="Проверьте, что у вас есть три вещи">
        <Bullets
          items={[
            <>
              Доступ к <Out href={BUSINESS_URL}>Meta Business Portfolio</Out> (бывший Business
              Manager) с правами администратора. Если портфолио ещё нет, Meta создаст его при
              первой настройке приложения.
            </>,
            <>
              Приложение Meta типа <b>Business</b> с добавленным продуктом <b>WhatsApp</b> —
              список приложений на <Out href={APPS_URL}>developers.facebook.com/apps</Out>.
            </>,
            <>
              <b>Отдельная SIM-карта, которой ещё не пользовались в WhatsApp.</b> Номер, уже
              заведённый в обычном WhatsApp или в WhatsApp Business на телефоне, Cloud API не
              примет.
            </>,
          ]}
        />
        <Note kind="danger">
          Привязка номера к WhatsApp Business Account необратима: Meta не отвяжет его обратно
          в обычный WhatsApp. Берите номер, который не жалко отдать бизнесу навсегда.
        </Note>
      </Step>

      <Step n={2} title="Убедитесь, что приложение Meta — то же, что настроено на сервере кабинета">
        <div>
          Кабинет принимает сообщения одним адресом вебхука и проверяет подпись одним
          секретом приложения. Токен, выпущенный в другом приложении Meta, подпишет на ваш
          WhatsApp Business Account это другое приложение — Meta примет номер, а сообщения
          пойдут не сюда.
        </div>
        <Note kind="warn">
          Если кабинет вам предоставляет поставщик, приложение Meta принадлежит ему: попросите
          добавить вас в это приложение (роль Developer) и выпускайте токен из него. Если
          кабинет ваш собственный, приложение — то, чьи <Path>App secret</Path> и verify token
          стоят в <Path>server/.env</Path>.
        </Note>
      </Step>

      <Step n={3} title="Добавьте номер в приложении: WhatsApp → API Setup → Add phone number">
        <Bullets
          items={[
            <>Имя отправителя — то, что клиент увидит вместо номера, и категория бизнеса.</>,
            <>
              Сам номер. Meta пришлёт код подтверждения по SMS или звонком — введите его на
              той же странице.
            </>,
          ]}
        />
        <div>
          После подтверждения номер появляется в списке <Path>From</Path> на странице{' '}
          <Path>API Setup</Path>.
        </div>
      </Step>

      <Step n={4} title="Заберите два идентификатора с той же страницы">
        <Bullets
          items={[
            <>
              <b>Phone number ID</b> — под выбранным номером в списке <Path>From</Path>. Это
              не сам номер, а его идентификатор: длинное число.
            </>,
            <>
              <b>WhatsApp Business Account ID</b> (WABA ID) — там же, отдельной строкой.
            </>,
          ]}
        />
        <div>Оба понадобятся на шаге 8. Их можно держать в блокноте — секретом они не являются.</div>
      </Step>

      <Step n={5} title="Выпустите постоянный токен системного пользователя">
        <div>
          На странице <Path>API Setup</Path> Meta показывает временный токен. Он живёт{' '}
          <b>24 часа</b>: подключиться им можно, но через сутки все ответы клиентам начнут
          отваливаться с ошибкой авторизации. Нужен другой:
        </div>
        <Bullets
          items={[
            <>
              <Out href={SYSTEM_USERS_URL}>Business settings → Users → System users</Out> →{' '}
              <Path>Add</Path>: заведите системного пользователя (или возьмите существующего).
            </>,
            <>
              <Path>Assign assets</Path>: выдайте ему доступ к приложению и к WhatsApp Business
              Account — с полным контролем, иначе прав на отправку не хватит.
            </>,
            <>
              <Path>Generate new token</Path> → выберите то самое приложение → срок действия{' '}
              <Path>Never</Path>.
            </>,
            <>
              Отметьте права <Path>whatsapp_business_messaging</Path> и{' '}
              <Path>whatsapp_business_management</Path>.
            </>,
          ]}
        />
        <Note kind="warn">
          Токен показывается один раз. Скопируйте его сразу — увидеть его повторно нельзя, можно
          только выпустить новый.
        </Note>
      </Step>

      <Step n={6} title="Пропишите вебхук: WhatsApp → Configuration → Webhook → Edit">
        {setup ? (
          <>
            <div>Скопируйте оба значения отсюда и вставьте в соответствующие поля Meta:</div>
            <Copy label="Callback URL" value={setup.url} />
            <Copy
              label="Verify token"
              value={setup.verifyToken}
              hint="Строка, которой Meta и сервер подтверждают друг другу, что настройка верна."
            />
            <div>
              Нажмите <Path>Verify and save</Path>. Meta тут же дёрнет адрес и должна принять
              его без ошибки.
            </div>
          </>
        ) : (
          <Note>
            Callback URL и verify token видны владельцу компании — это общий с Meta секрет.
            Попросите его выполнить этот шаг.
          </Note>
        )}
      </Step>

      <Step n={7} title="Подпишитесь на поле messages">
        <div>
          На той же странице, в списке <Path>Webhook fields</Path>, найдите строку{' '}
          <Path>messages</Path> и нажмите <Path>Subscribe</Path>.
        </div>
        <Note kind="warn">
          Это единственный шаг, который выглядит необязательным и им не является: без подписки
          Meta подтвердит вебхук и не пришлёт по нему ни одного сообщения. Кабинет об этом не
          узнает — для него просто никто не пишет.
        </Note>
      </Step>

      <Step n={8} title="Подключите номер в кабинете: Интеграции → «Подключить номер WhatsApp»">
        <div>Заполните три поля и нажмите «Подключить»:</div>
        <Bullets
          items={[
            <>
              <b>Phone number ID</b> и <b>WhatsApp Business Account ID</b> — из шага 4.
            </>,
            <>
              <b>Токен доступа</b> — постоянный токен из шага 5. Он хранится в зашифрованном
              виде и обратно не показывается.
            </>,
          ]}
        />
        <div>По кнопке кабинет делает две вещи по очереди и обе обязаны пройти:</div>
        <Bullets
          items={[
            <>проверяет токен, запросив по нему номер у Meta — негодный токен не сохранится;</>,
            <>
              подписывает приложение на ваш WhatsApp Business Account — тот самый шаг, без
              которого сообщения не доходят.
            </>,
          ]}
        />
      </Step>

      <Step n={9} title="Проверьте живым сообщением">
        <Bullets
          items={[
            <>С телефона, номер которого не совпадает с подключённым, напишите на подключённый номер.</>,
            <>В разделе «Диалоги» за несколько секунд должен появиться новый диалог с этим сообщением.</>,
            <>Ответьте на него из кабинета — ответ придёт в WhatsApp на тот же телефон.</>,
          ]}
        />
        <div>
          Пока этого не произошло, подключение считается незавершённым, чем бы ни было
          написано в списке номеров.
        </div>
      </Step>

      <Step n={10} title="Снимите ограничения тестового режима">
        <Bullets
          items={[
            <>
              Пока номер в режиме разработки, писать можно только номерам из списка{' '}
              <Path>WhatsApp → API Setup → To</Path>. Ответ постороннему вернётся ошибкой про
              allowed list.
            </>,
            <>
              До верификации бизнеса номер может писать <b>250 уникальным собеседникам в
              сутки</b>. Это ограничение Meta, не кабинета: оно снимается верификацией бизнеса
              в Business Portfolio.
            </>,
          ]}
        />
      </Step>

      <Troubles
        items={[
          {
            sign: 'Клиенты пишут, а в «Диалогах» пусто',
            why: (
              <>
                Приложение не подписано на WhatsApp Business Account — кабинет пишет об этом
                красной строкой прямо в списке номеров, — либо в настройках вебхука не
                отмечено поле <Path>messages</Path> (шаг 7). Второе видно только в Meta.
              </>
            ),
          },
          {
            sign: 'Meta приняла вебхук, но сообщения всё равно не идут',
            why: (
              <>
                Вебхук прописан в другом приложении Meta, а не в том, с которым работает
                сервер: подпись такого запроса кабинет отклоняет. Вернитесь к шагу 2.
              </>
            ),
          },
          {
            sign: 'При подключении кабинет пишет «Meta не приняла эти данные: …»',
            why: <>Токен временный и уже протух, либо введён с опечаткой. Нужен постоянный — шаг 5.</>,
          },
          {
            sign: 'Ответ не уходит: «Окно ответа закрыто»',
            why: (
              <>
                С последнего сообщения клиента прошло больше 24 часов — WhatsApp закрывает
                окно свободной переписки. Пока клиент не напишет снова, ответить нельзя;
                шаблоны для отправки вне окна появятся позже.
              </>
            ),
          },
          {
            sign: 'Ответ не уходит: ошибка про allowed list',
            why: <>Номер в тестовом режиме, получателя нет в списке разрешённых — шаг 10.</>,
          },
          {
            sign: 'Всё работало и внезапно перестало',
            why: (
              <>
                Почти всегда это истёкший токен. Меняется он кнопкой «Обновить токен» рядом с
                номером — удалять номер не нужно и нельзя: вместе с ним уйдут все переписки и
                данные о рекламе, из которой пришли клиенты.
              </>
            ),
          },
        ]}
      />
    </Steps>
  );
}
