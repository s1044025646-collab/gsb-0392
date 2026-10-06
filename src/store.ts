import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OPERATION_SCHEMA_VERSION, resolveDataDir } from './config.js';

export interface DataStore {
  root: string;
  originalsDir: string;
  outputsDir: string;
  tmpDir: string;
  db: DatabaseSync;
}

let activeStore: DataStore | null = null;

export async function initStore(explicitDataDir?: string): Promise<DataStore> {
  if (activeStore) return activeStore;
  const root = resolveDataDir(explicitDataDir);
  const originalsDir = path.join(root, 'originals');
  const outputsDir = path.join(root, 'outputs');
  const tmpDir = path.join(root, 'tmp');
  await fs.mkdir(originalsDir, { recursive: true });
  await fs.mkdir(outputsDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });

  const db = new DatabaseSync(path.join(root, 'lsb.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('original','output')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS payloads (
      sha256 TEXT PRIMARY KEY,
      byte_length INTEGER NOT NULL,
      input_encoding TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('embed','check')),
      status TEXT NOT NULL CHECK(status IN ('success','failed')),
      source_image_id INTEGER REFERENCES images(id),
      output_image_id INTEGER REFERENCES images(id),
      payload_sha256 TEXT REFERENCES payloads(sha256),
      payload_length INTEGER,
      output_path TEXT,
      error_code TEXT,
      error_message TEXT,
      report_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  activeStore = { root, originalsDir, outputsDir, tmpDir, db };
  return activeStore;
}

export function schemaVersion(): string {
  return OPERATION_SCHEMA_VERSION;
}
