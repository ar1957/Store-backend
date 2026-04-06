/**
 * Normalize a US phone number to 10 digits (no country code, no formatting).
 * "12133612190" → "2133612190"
 * "(213) 361-2190" → "2133612190"
 */
export function normalizePhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined
  const digits = phone.replace(/\D/g, "")
  // Strip leading country code "1" if 11 digits
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  return normalized.length === 10 ? normalized : undefined
}
