import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const DEFAULT_ISSUER = 'Joplin Web';

/**
 * Encodes a byte buffer as unpadded uppercase RFC 4648 Base32.
 */
export function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Decodes an RFC 4648 Base32 string (ignoring whitespace and trailing '=' padding).
 */
export function decodeBase32(input: string): Buffer {
  const clean = input.replace(/[\s=]+/g, '').toUpperCase();
  if (!clean) throw new Error('Invalid Base32 secret');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid Base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generates a fresh 160-bit Base32-encoded TOTP secret.
 */
export function generateTotpSecret(numBytes = 20): string {
  return encodeBase32(randomBytes(numBytes));
}

/**
 * Computes an RFC 4226 6-digit HOTP code using HMAC-SHA1.
 */
export function computeHotp(secretBytes: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = createHmac('sha1', secretBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Computes the current RFC 6238 TOTP code for the given Base32 secret.
 */
export function computeTotp(secret: string, nowMs = Date.now()): string {
  const secretBytes = decodeBase32(secret);
  const step = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  return computeHotp(secretBytes, step);
}

/**
 * Verifies a 6-digit TOTP code within ±1 time step (30 s period, SHA-1) and rejects reuse of
 * the last accepted time step (or any earlier step).
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { nowMs?: number; lastUsedStep?: number | null; window?: number } = {}
): { valid: boolean; step: number | null } {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return { valid: false, step: null };
  }

  let secretBytes: Buffer;
  try {
    secretBytes = decodeBase32(secret);
  } catch {
    return { valid: false, step: null };
  }

  const nowMs = options.nowMs ?? Date.now();
  const window = options.window ?? 1;
  const currentStep = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  const candidateBuf = Buffer.from(normalized, 'utf8');

  let matchedStep: number | null = null;
  for (let delta = -window; delta <= window; delta++) {
    const step = currentStep + delta;
    if (step < 0) continue;
    const expectedBuf = Buffer.from(computeHotp(secretBytes, step), 'utf8');
    if (timingSafeEqual(expectedBuf, candidateBuf)) {
      matchedStep = step;
    }
  }

  if (matchedStep === null) {
    return { valid: false, step: null };
  }

  if (options.lastUsedStep !== null && options.lastUsedStep !== undefined && matchedStep <= options.lastUsedStep) {
    return { valid: false, step: null };
  }

  return { valid: true, step: matchedStep };
}

/**
 * Builds the `otpauth://` provisioning URI for authenticator apps.
 */
export function buildOtpauthUri(secret: string, accountLabel: string, issuer = DEFAULT_ISSUER): string {
  const safeLabel = accountLabel.trim() || 'user';
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(safeLabel)}` +
    `?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}

/**
 * Renders an `otpauth://` URI as an SVG `data:` URL (compatible with strict img-src CSP).
 */
export async function generateQrSvgDataUrl(otpauthUri: string): Promise<string> {
  const svg = await QRCode.toString(otpauthUri, {
    type: 'svg',
    margin: 2,
    width: 220,
    errorCorrectionLevel: 'M',
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
