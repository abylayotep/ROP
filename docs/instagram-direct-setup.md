# Instagram Direct setup

Rakurs receives new Instagram Direct messages through the Meta webhook and can send text replies from the shared dialog inbox. It does not import earlier Direct history and does not send attachments.

## Meta assets and access

Use the same Meta application configured by `META_APP_ID` and `META_APP_SECRET`. The seller needs an Instagram professional account linked to a Facebook Page and a Facebook user who has the Page `MESSAGING` task.

The Direct login requests `instagram_basic`, `pages_show_list`, `instagram_manage_messages`, and `pages_manage_metadata`. The separate knowledge import continues to request `pages_read_engagement` because it reads post captions.

In development mode, every Facebook and Instagram user involved in the smoke test must have an eligible role on the Meta application and accept the required access. For customer accounts outside application roles, complete the applicable App Review, Advanced Access, and Business Verification steps before switching the application live.

## OAuth and webhook

Configure the production cabinet origin and OAuth redirect settings in the Meta application. The browser receives a short-lived authorization code and sends it to Rakurs immediately. Rakurs discovers the Page-linked Instagram account, stores only the encrypted Page token, subscribes the current Meta application to the Page `messages` field, and verifies that subscription before reporting the account as ready.

Configure the Instagram webhook callback as:

```text
https://YOUR_PUBLIC_HOST/api/instagram/webhook
```

Use the value of `META_WEBHOOK_VERIFY_TOKEN` as the verification token and subscribe the Instagram object to `messages`. `PUBLIC_URL` must use the same public HTTPS host. Incoming POST requests are accepted only when `X-Hub-Signature-256` matches `META_APP_SECRET`.

The Page subscription performed by Rakurs does not configure the app-level Instagram webhook callback. Both settings are required.

## Controlled smoke test

1. In Integrations, connect Instagram Direct and select the intended account when Meta offers more than one.
2. Confirm that the card shows the username, enabled state, and active message subscription.
3. From a separate Instagram account, send a new text message to the professional account. The customer must initiate the conversation.
4. Confirm that the dialog appears with the Instagram label and sender identity.
5. Reply with text from Rakurs within 24 hours of the customer's last message.
6. Enable AI only for a controlled test conversation and confirm that one inbound text produces at most one response.
7. Disable the connection and confirm that history remains visible while new replies are rejected.

Reconnect through the same Meta login when access is revoked or known to be expired. Reconnection updates credentials for the same Instagram professional account and preserves its conversations.

As with the existing WhatsApp transport, a network failure after Meta accepts a send but before Rakurs records the returned message ID is ambiguous. Operators should check the provider conversation before retrying an uncertain send.

## Limits

- The standard response window is 24 hours from the most recent inbound customer message.
- Rakurs does not initiate Instagram conversations or use a human-agent tag.
- Incoming attachments are shown as unsupported and do not trigger an AI interpretation.
- Sending files and historical inbox synchronization are outside this release.
- Instagram contacts do not have fabricated phone numbers. Kaspi checkout requires a real phone number.

Current protocol references:

- [Meta Messenger Platform text message request](https://www.postman.com/meta/messenger-platform-api/request/poazquh/text-message)
- [Meta Instagram API with Facebook Login](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login)
