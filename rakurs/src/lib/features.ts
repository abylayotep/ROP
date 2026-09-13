/**
 * Build-time feature flags. Each flag is read in one place so a screen asks a question
 * («can a new phone be paired by QR?») instead of parsing environment strings itself.
 */

type FeatureEnv = Pick<ImportMetaEnv, 'VITE_WHATSAPP_QR_ENABLED'>;

/**
 * Whether the cabinet offers pairing a NEW phone by QR (the unofficial linked-device path).
 *
 * Off unless the build sets `VITE_WHATSAPP_QR_ENABLED=true`: the production build shown to
 * Meta App Review connects WhatsApp only through the official Cloud API. Numbers already
 * paired by QR keep their status and reconnect controls regardless of this flag.
 */
export function whatsappQrPairingEnabled(env: FeatureEnv = import.meta.env): boolean {
  return env.VITE_WHATSAPP_QR_ENABLED === 'true';
}
