# Meta Setup Verification

Verified on 2026-09-11. This note records public evidence and the checks that still require access to the private Meta app.

## Conversions API

The cabinet asks for a Meta dataset ID, a system-user access token, and an optional Test Events code. On the first save or when the dataset/token changes, the server sends one synthetic verification event before storing the credentials. A successful provider response proves that Meta accepted that request; it does not prove that later purchase events are visible in Events Manager.

Operator check:

1. Open [Meta Events Manager](https://business.facebook.com/events_manager2), select the dataset, and copy its ID from Settings.
2. Open Test Events and copy the test event code into the cabinet.
3. Save the dataset and token. Confirm both the cabinet's accepted-response timestamp and the synthetic event in Test Events.
4. Remove the test code before production optimization. Mark a real attributed test order only when intentionally testing the business flow; the settings screen does not send a purchase automatically.

The public [Meta Conversions API documentation](https://developers.facebook.com/docs/marketing-api/conversions-api/) returned HTTP 429 during this review, so its current wording was not independently rechecked. Private dataset permissions and system-user asset assignment remain dashboard-only checks.

## Instagram Login

Meta's official [Instagram API with Facebook Login collection](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login) documents the Facebook Login route used by this project. The current local OAuth request uses that route's Facebook permissions; no unsupported scope change was justified by public evidence.

An `Invalid Scopes` report cannot be declared fixed without the private app evidence below:

- the exact OAuth request URL and returned error;
- enabled products and app mode;
- approved permissions for the requesting app/user;
- the Instagram professional account's Page and Business connections;
- the Embedded Signup configuration ID and its allowed assets.

No credential, app-dashboard setting, or provider configuration was changed during this review.
