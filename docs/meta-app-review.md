# Meta App Review — submission texts

App "Tasbaqa" (id 1585667806534384), product Rakurs at https://rop.tasbaqa.ru.
Submission started 2026-09-13. Keep this file in sync with what is pasted into the form.

## Scope

Requested (used in code): `whatsapp_business_messaging`, `whatsapp_business_management`,
`instagram_basic`, `instagram_manage_messages`, `pages_show_list`, `pages_manage_metadata`,
`pages_read_engagement`, `public_profile`.

Removed from the request because no code uses them through our app: `business_management`,
`ads_read`, `ads_management`, `Marketing API Access Tier`, `manage_app_solution`,
`whatsapp_business_manage_events`. Conversions API runs on a token the business pastes itself.

Before submitting:

- Every permission needs a successful API call from this app within 30 days. Connect a real
  WhatsApp number (Embedded Signup) and a real Instagram account on production first.
- The production build hides QR pairing (`VITE_WHATSAPP_QR_ENABLED` unset).
- App settings point to `/privacy?lang=en`, `/terms?lang=en`, `/data-deletion?lang=en`.

## Data handling answers

- Processors: PS Internet Company LLP (hosting, Kazakhstan); OpenRouter, Inc., and through it
  OpenAI, L.L.C., Google LLC, Anthropic, PBC (AI replies and transcription, USA). All are
  "IT services".
- Controller: ИП Абылай (Individual Entrepreneur Abylay), Kazakhstan.
- National-security requests in the last 12 months: none.
- Policies for government requests: legality review, data minimisation, documentation.

## Permission descriptions

### whatsapp_business_messaging

Tasbaqa (product name Rakurs, https://rop.tasbaqa.ru) is a CRM for small businesses in
Kazakhstan that sell through WhatsApp. A business owner connects their own WhatsApp Business
number with Embedded Signup (Integrations → "Подключить через Meta"). We use
whatsapp_business_messaging to: (1) receive incoming customer messages and media through the
webhook and show them in the shared inbox ("Диалоги" / Dialogs); (2) send replies written by
the business's staff, or drafted by the AI assistant and sent on the business's behalf,
including images, documents, audio and video; (3) download incoming media so staff can view it
and voice notes can be transcribed. We reply to customers who wrote to the business first; we do
not send bulk or marketing messages. Without this permission the business cannot read or answer
its WhatsApp customers from the CRM.

### whatsapp_business_management

Used during and after Embedded Signup to manage the WhatsApp Business Account the owner
connects: we read the phone number (display number, verified name, platform type) to confirm
which number was connected, list the account's phone numbers to verify it belongs to that WABA,
subscribe our app to the WABA webhooks so messages reach the CRM, and request the one-time
contacts and chat-history sync for WhatsApp Business app coexistence. The owner sees the
connected number and its status on the Integrations screen and can disconnect it there. Without
this permission we cannot verify and subscribe the number the business connected.

### instagram_basic

When the owner clicks "Подключить Instagram Direct" on the Integrations screen, we read the
Instagram professional account linked to their Facebook Page (id and username) so the owner can
choose which account to connect and see it labelled in the CRM. In the Knowledge Base
("База знаний" → "Забрать из Instagram") the owner can also import captions and links of their
own posts, so the AI assistant answers customers with accurate product information. We read only
the account the owner selected.

### instagram_manage_messages

Lets a business answer Instagram Direct messages from the same CRM inbox as WhatsApp. After the
owner connects their Instagram professional account, incoming Direct messages arrive through the
webhook and appear in "Диалоги" (Dialogs). Staff, or the AI assistant on the business's behalf,
reply, and we send the reply with the Send API as a RESPONSE inside the messaging window. We do
not send unsolicited messages. The owner can turn Instagram Direct off at any time on the
Integrations screen.

### pages_show_list

Instagram messaging for professional accounts goes through the Facebook Page linked to the
account. We call /me/accounts to show the owner the Pages they manage together with the linked
Instagram account, so they can choose which one to connect to the CRM. We store only the
selected Page id, its name and its Page access token (encrypted at rest).

### pages_manage_metadata

After the owner selects a Page, we subscribe our app to that Page's `messages` webhook and read
the subscription back to confirm it. This is required to receive Instagram Direct messages in the
CRM inbox. When the owner turns Instagram Direct off, we stop processing its messages.

### pages_read_engagement

Needed together with pages_show_list to read the Page fields that identify the connected
account: Page name, Page access token and the linked Instagram business account (id, username).
We use them to show the owner which Page and Instagram account is connected and to send replies
from the correct Page. We do not read the Page's posts, comments or insights.

### public_profile

Default permission for Facebook Login; we do not store profile data.

## Reviewer instructions

The interface is in Russian; English meanings of the labels are given in brackets.

1. Open https://rop.tasbaqa.ru/ and sign in with the test account from the credentials field.
   There is no public sign-up; we created this account for review.
2. Open the company in the list, then "Интеграции" (Integrations) in the left sidebar.
3. WhatsApp (whatsapp_business_management, whatsapp_business_messaging): the test company already
   has a WhatsApp number connected through Embedded Signup; the number is shown on the
   Integrations screen. Send a WhatsApp message to that number. Open "Диалоги" (Dialogs): the message appears in the list. Open it, type a
   reply and press send; the reply arrives in WhatsApp. To see Embedded Signup itself, watch the
   screencast: a new number is connected with "Подключить через Meta" (Connect with Meta).
4. Instagram (instagram_basic, instagram_manage_messages, pages_show_list, pages_manage_metadata,
   pages_read_engagement): on "Интеграции" the card "Instagram Direct" shows the connected account.
   "Переподключить" (Reconnect) opens Facebook Login, lists your Pages with their Instagram
   accounts, and subscribes the selected Page. Send a Direct message to the connected account; it
   appears in "Диалоги"; reply from there.
5. Knowledge base (instagram_basic): "База знаний" (Knowledge base) → "Забрать из Instagram"
   (Import from Instagram) imports captions of the account's own posts.
6. Legal pages: https://rop.tasbaqa.ru/privacy?lang=en, /terms?lang=en, /data-deletion?lang=en.

## Screencast script (one video, reuse it for every permission)

1. Login page with the legal links visible; sign in.
2. Integrations → "Подключить через Meta" → Embedded Signup popup → pick the business and number →
   success toast "Номер подключён".
3. Phone sends a WhatsApp message → it appears in Dialogs → reply from the CRM → reply shows on the
   phone.
4. Integrations → "Подключить Instagram Direct" → Facebook Login consent screen showing the five
   Instagram and Page permissions → choose the Page → toast "Instagram Direct подключён".
5. Phone sends an Instagram Direct message → it appears in Dialogs → reply → reply shows in
   Instagram.
6. Knowledge base → "Забрать из Instagram" → imported posts listed.
7. Integrations → disconnect or turn off, to show the business controls its data.

Record in English UI captions if possible (add on-screen text for Russian labels), 1080p, no
sensitive customer data on screen.
