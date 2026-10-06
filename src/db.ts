import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export interface CarrierRow {
  id: number;
  sha256: string;
  width: number;
  height: number;
  path: string;
  created_at: string;
}

export interface OutputRow {
  id: number;
  carrier_id: number;
  payload_sha256: string;
  payload_len: number;
  path: string;
  status: string;
  report: string | null;
  version: number;
  created_at: string;
}

export class Store {
  db: DatabaseSync;
  constructor(public dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "carriers"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "derived"), { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "lsb1.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS carriers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        carrier_id INTEGER NOT NULL REFERENCES carriers(id),
        payload_sha256 TEXT NOT NULL,
        payload_len INTEGER NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        report TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  addCarrier(sha256: string, width: number, height: number, p: string): number {
    const r = this.db
      .prepare("INSERT INTO carriers (sha256, width, height, path) VALUES (?,?,?,?)")
      .run(sha256, width, height, p);
    return Number(r.lastInsertRowid);
  }

  getCarrier(id: number): CarrierRow | undefined {
    return this.db.prepare("SELECT * FROM carriers WHERE id=?").get(id) as CarrierRow | undefined;
  }

  addOutput(o: Omit<OutputRow, "id" | "created_at">): number {
    const r = this.db
      .prepare(
        "INSERT INTO outputs (carrier_id, payload_sha256, payload_len, path, status, report, version) VALUES (?,?,?,?,?,?,?)",
      )
      .run(o.carrier_id, o.payload_sha256, o.payload_len, o.path, o.status, o.report, o.version);
    return Number(r.lastInsertRowid);
  }

  updateOutputReport(id: number, status: string, report: string): void {
    this.db.prepare("UPDATE outputs SET status=?, report=? WHERE id=?").run(status, report, id);
  }

  getOutput(id: number): OutputRow | undefined {
    return this.db.prepare("SELECT * FROM outputs WHERE id=?").get(id) as OutputRow | undefined;
  }

  listOutputs(): OutputRow[] {
    return this.db.prepare("SELECT * FROM outputs ORDER BY id").all() as unknown as OutputRow[];
  }
}
