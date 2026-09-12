# WhatsApp Sync Key Repair

Date: 2026-09-12 (Asia/Almaty). Code commit: `c083d8b`.

## Evidence and fix

- Production had an enabled linked number, stored identity and app-state key, zero
  processed history messages, zero account sync counter, and zero stored conversations.
- A read-only diagnostic returned only key metadata: `keyPresent=true`,
  `keyDataType=string`, `keyDataIsBytes=false`. No key material was printed or exported.
- The pinned Baileys 6.7.24 auth-state reference restores `app-state-sync-key` values with
  `proto.Message.AppStateSyncKeyData.fromObject`. Our database adapter omitted this step.
  Protobuf JSON serializes the bytes as base64; the generic BufferJSON reviver alone does
  not restore those strings. Wrong bytes can prevent app-state synchronization and the
  subsequent flush of buffered history events.
- The fix performs this conversion only when reading that key category. Existing rows,
  encryption, session identity, and other key categories are unchanged. No QR reset or
  logout is needed to apply the code correction.
- A real encrypted-database regression failed before the fix with `AQID` instead of
  `Uint8Array`, then passed with the original bytes restored. Typecheck and build passed.
  Astra reviewed compatibility with Buffer, Uint8Array, and saved base64 representations.
- A one-off command in the prepared image read the same existing production key without
  writing rows or starting a WhatsApp socket. Its metadata became `keyDataType=object`,
  `keyDataIsBytes=true`, confirming compatibility with the already-stored key.

## Instagram configuration

The signed-in Meta console for app `1585667806534384` showed only the WhatsApp use case.
Instagram is available as an additional compatible use case. Saving its addition was
blocked by the approval reviewer because it changes the application's capabilities.
Explicit user permission was requested. The selection is unsaved; no Instagram capability
or permission is claimed to have been enabled.

## Rollout

A protected PostgreSQL backup and previous API image were retained on the VPS.
The full serial server suite passed: 96 files, 1,307 tests, exit 0, 213.73 seconds, against
the dedicated local test database. No production test fixture or truncation was used.

The API-only correction was deployed after that gate. Running image:
`sha256:7bdc1e05059da7f56aff5d1a8b305a0487a076d4f32c0f142dd086fa9bba9d33`.
The container is running with zero restarts; readiness and public health checks passed.
The running API now returns `keyDataIsBytes=true` for the existing stored sync key.
Browser reload succeeded with no captured JavaScript errors.

History progress, processed-history count, account sync counter, and stored messages
remain zero after cutover. The serialization defect is fixed, but retrospective delivery
has not been established. A fresh inbound event or phone-side sync is still required to
verify the live path; no customer message was sent automatically.
