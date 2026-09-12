const KAZAKHSTAN_LOCAL_LENGTH = 10;

export function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === KAZAKHSTAN_LOCAL_LENGTH) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

export function formatPhone(value: string | null | undefined): string {
  if (!value) return 'Номер не указан';
  const digits = phoneDigits(value);
  if (digits.length !== 11 || !digits.startsWith('7')) return value;
  return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 9)} ${digits.slice(9)}`;
}
