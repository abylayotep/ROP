import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, kaspiSessions } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

let db: Awaited<ReturnType<typeof withDb>>;
let app: ReturnType<typeof buildServer>;
let agentId: string;
let cookies: Record<string, string>;
const provider = vi.fn();
beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, { company: 'Test', email: 'owner@example.com', name: 'Owner', initials: 'OW', password: 'correct-horse-battery' });
  agentId = (await db.insert(agents).values({ accountId, name: 'Test' }).returning())[0]!.id;
  app = buildServer(testEnv({ KASPI_POS_URL: 'http://kaspi.test' }), db, { graph: fakeGraph() });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'correct-horse-battery' } });
  cookies = { [login.cookies[0]!.name]: login.cookies[0]!.value };
  provider.mockReset();
  vi.stubGlobal('fetch', provider);
  await db.insert(kaspiSessions).values({ agentId, processId: 'challenge', processExpiresAt: new Date(Date.now() + 60_000), credentials: 'existing-encrypted-credentials' });
});
afterEach(async () => { vi.unstubAllGlobals(); await app?.close(); });
function reply(body: unknown) { provider.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 })); }
function post(path: string, payload = {}) { return app.inject({ method: 'POST', url: `/api/agents/${agentId}/kaspi/auth/${path}`, cookies, payload }); }
it('explains organization confirmation and invalidates only the challenge', async () => {
  reply({ success: false, view: 'KPMobileCall', body: { meta: { sn: 'MobileOrgRegistration' }, data: { type: 'kpOrgRegistration' } } });
  const res = await post('send-phone', { phone: '+7 771 523 03 42' });
  expect(res.statusCode).toBe(400);
  expect(res.json().message).toContain('Kaspi Pay');
  expect(res.json().message).toContain('организации');
  const [session] = await db.select().from(kaspiSessions).where(eq(kaspiSessions.agentId, agentId));
  expect(session?.processId).toBeNull();
  expect(session?.credentials).toBe('existing-encrypted-credentials');
  expect((await post('send-phone', { phone: '+77715230342' })).statusCode).toBe(409);
  expect(provider).toHaveBeenCalledTimes(1);
});
it('accepts only an actual OTP screen and sends a national phone number', async () => {
  reply({ success: true, view: 'EnterOtp' });
  expect((await post('send-phone', { phone: '+77715230342' })).json()).toEqual({ sent: true });
  expect(JSON.parse(provider.mock.calls[0]![1].body).phoneNumber).toBe('7715230342');
});
it('does not report SMS delivery for a different successful screen', async () => {
  reply({ success: true, view: 'KPMobileCall' });
  expect((await post('send-phone', { phone: '+77715230342' })).statusCode).toBe(400);
});
it('explains a closed provider session', async () => {
  reply({ success: false, body: { isClosed: true, view: { code: 'SystemError' } } });
  const res = await post('send-phone', { phone: '+77715230342' });
  expect(res.json().message).toContain('заново');
});
it('rejects initialization without the expected phone screen', async () => {
  reply({ success: true, processId: 'new', view: 'SystemError' });
  expect((await post('init')).statusCode).toBe(502);
});
