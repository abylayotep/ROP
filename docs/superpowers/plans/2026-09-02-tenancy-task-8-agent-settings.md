# Task 8: Agent settings, creation, and the README

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

The two places an owner acts on an agent: the settings form that renames it, and the button
that creates the next one. Both exercise the owner role in the interface, so the 403 the API
already returns is something a member never has to run into.

Ends the stage by telling the truth in the README: which commands exist now, and which stage
brings what.

**Files:**
- Create: `rakurs/src/screens/AgentSettingsScreen.tsx`
- Modify: `rakurs/src/screens/AgentsScreen.tsx`, `rakurs/src/App.tsx`
- Modify: `README.md`, `rakurs/README.md`

**Interfaces:**
- Consumes: `updateAgent`, `createAgent` from Task 5; `useAgent()` from Task 6;
  `useToast()` from `rakurs/src/components/ui/Toast.tsx`.
- Produces: nothing later tasks depend on — this is the last task of the stage.

---

The toast API this task uses, already in the codebase:
`const toast = useToast()` with `toast.ok(text: string)` and
`toast.fail(error: unknown, fallback?: string)` — `fail` renders the fallback when given one
and `humanError(error)` otherwise.

- [ ] **Step 1: Write the settings screen**

Create `rakurs/src/screens/AgentSettingsScreen.tsx`:

```tsx
import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { useAgent } from '@/store/agent';

const field: CSSProperties = {
  width: '100%',
  maxWidth: 460,
  padding: '10px 12px',
  marginTop: 6,
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  outline: 'none',
};

const label: CSSProperties = { fontSize: 12.5, color: 'var(--text-dim)' };

/** Timezones the cabinet offers. More arrive when a client needs one. */
const ZONES = ['Asia/Almaty', 'Asia/Tashkent', 'Europe/Moscow', 'UTC'];

export function AgentSettingsScreen() {
  const { agent, role, replace } = useAgent();
  const toast = useToast();

  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [timezone, setTimezone] = useState(agent.timezone);
  const [saving, setSaving] = useState(false);

  const readOnly = role !== 'owner';
  const dirty =
    name !== agent.name || description !== agent.description || timezone !== agent.timezone;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return toast.fail(undefined, 'Название агента не может быть пустым');

    setSaving(true);
    try {
      replace(await api.updateAgent(agent.id, { name, description, timezone }));
      toast.ok('Сохранено');
    } catch (error) {
      // The saved values stay on screen: retyping them after a failed save is the
      // last thing anyone wants to do.
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={label}>Название</div>
          <input
            style={field}
            value={name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <div style={label}>Описание</div>
          <input
            style={field}
            value={description}
            disabled={readOnly}
            placeholder="Чем занимается этот агент"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <div style={label}>Часовой пояс</div>
          <select
            style={field}
            value={timezone}
            disabled={readOnly}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {/* An agent moved to a zone the list does not offer must still show its own. */}
            {(ZONES.includes(timezone) ? ZONES : [timezone, ...ZONES]).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>

        {readOnly ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            Настройки агента меняет владелец компании.
          </div>
        ) : (
          <div>
            <button type="submit" className="btn" disabled={!dirty || saving}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}
```

- [ ] **Step 2: Route settings to the real screen**

In `rakurs/src/App.tsx` import `AgentSettingsScreen` and give that one path its own element:

```tsx
        {SECTIONS.map((section) => (
          <Route
            key={section.path}
            path={section.path}
            element={
              section.path === 'settings' ? (
                <AgentSettingsScreen />
              ) : (
                <SectionScreen section={section} />
              )
            }
          />
        ))}
```

- [ ] **Step 3: Add the create button to the picker**

In `rakurs/src/screens/AgentsScreen.tsx`, add the state and handler above the return:

```tsx
  const [creating, setCreating] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const toast = useToast();

  async function create(accountId: string) {
    if (!newName.trim()) return toast.fail(undefined, 'Укажите название агента');
    try {
      const agent = await api.createAgent(accountId, {
        name: newName,
        description: '',
        timezone: 'Asia/Almaty',
      });
      setCreating(null);
      setNewName('');
      navigate(`/a/${agent.id}/settings`);
    } catch (error) {
      toast.fail(error);
    }
  }
```

with `import { useState } from 'react';`, `import { useNavigate } from 'react-router-dom';`,
`import { useToast } from '@/components/ui/Toast';` and `const navigate = useNavigate();`.

Inside the account section, next to the account name, render the control for owners only:

```tsx
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        letterSpacing: '0.4px',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                      }}
                    >
                      {account.name}
                    </div>

                    {account.role === 'owner' &&
                      (creating === account.id ? (
                        <>
                          <input
                            autoFocus
                            value={newName}
                            placeholder="Название агента"
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void create(account.id);
                              if (e.key === 'Escape') setCreating(null);
                            }}
                            style={{
                              padding: '5px 9px',
                              background: 'var(--sunken)',
                              color: 'var(--text)',
                              border: '1px solid var(--line)',
                              borderRadius: 7,
                              font: 'inherit',
                              fontSize: 12.5,
                            }}
                          />
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void create(account.id)}
                          >
                            Создать
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setCreating(account.id)}
                        >
                          Создать агента
                        </button>
                      ))}
                  </div>
```

replacing the plain account-name div that was there. A new agent lands on its own settings
screen: its name is the only thing that exists yet, and that is where it is edited.

- [ ] **Step 4: Typecheck and build**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS.

- [ ] **Step 5: Try both roles in a browser**

1. As the owner: create an agent from the picker, land on its settings, rename it, reload —
   the new name is in the sidebar and in the picker.
2. Demote yourself and check the member's view:
   ```bash
   docker compose -f deploy/compose.dev.yml exec -T db \
     psql -U rakurs -d rakurs_dev -c "update account_members set role = 'member';"
   ```
   Sign out and in again. The settings fields are disabled with the owner note, and the
   picker has no create button. Then put the role back:
   ```bash
   docker compose -f deploy/compose.dev.yml exec -T db \
     psql -U rakurs -d rakurs_dev -c "update account_members set role = 'owner';"
   ```

- [ ] **Step 6: Update the README**

In `README.md`, replace the user-creation command with:

````markdown
Завести компанию и её владельца — экрана регистрации нет, аккаунты заводятся из терминала:

```bash
npm --prefix server run create-account
```

Добавить сотрудника в существующую компанию:

```bash
npm --prefix server run add-member
```
````

and replace the stage table with:

```markdown
| Этап | Что подключает | Состояние |
|---|---|---|
| 1 | Компании, агенты, роли, каркас кабинета | готово |
| 2 | WhatsApp Cloud API: подключение номера, диалоги, вебхук | дальше |
| 3 | Заказы: воронка, канбан, карточка лида | |
| 4 | База знаний: документы, товары, поиск | |
| 5 | ИИ-агент: скрипт продаж, модели OpenRouter, инструменты | |
| 6 | Meta Conversions API: покупки обратно в рекламу | |
| 7 | Статистика: воронка, конверсия, источники | |
```

Under «Что уже работает», replace the paragraph about connected screens with:

```markdown
Вход и выход, компании и агенты, настройки агента — на настоящих данных из PostgreSQL.

Остальные разделы показывают, на каком этапе они появятся. Это ожидаемое состояние, а не
поломка: экран без эндпоинта честно об этом говорит.
```

`rakurs/README.md` needs more than a section rename: Task 5 deleted the fixture server and the
prototype API surface it documents. Rewrite it so that every statement is true of the cabinet as
it stands — the seven sections are Заказы, Диалоги, База знаний, Агент, Интеграции, Статистика,
Настройки; there is no `mock-server/` and no `npm run mock`; the endpoints it describes are the
ones `rakurs/src/api/index.ts` actually calls. Delete whatever describes screens that no longer
exist rather than rewording it.

- [ ] **Step 7: Run everything one last time**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS, all four.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add agent settings and creation, and update the README for the new stages"
```
