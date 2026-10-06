import path from 'node:path';

export const APP_VERSION = '1.0.0';
export const OPERATION_SCHEMA_VERSION = 'LSB1-v1';

export const LIMITS = {
  maxInputBytes: 20 * 1024 * 1024,
  maxEncodedPngBytes: 20 * 1024 * 1024,
  maxPayloadBytes: 20 * 1024 * 1024,
  maxImageDimension: 4096,
  maxJsonBytes: 24 * 1024 * 1024,
} as const;

export function resolveDataDir(explicit?: string): string {
  return path.resolve(explicit ?? process.env.PNG_LSB_DATA_DIR ?? path.join(process.cwd(), 'data'));
}
