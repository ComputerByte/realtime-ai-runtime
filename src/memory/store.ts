import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { RuntimeEvent } from '../events/types.js';

export interface Fact {
  id: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

// Migrations stay with the store so both compiled builds and tests use the same schema.
const migrations = [
  `CREATE TABLE facts (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    sessionId TEXT NOT NULL, correlationId TEXT NOT NULL, event TEXT NOT NULL
  );
  CREATE INDEX events_session ON events(sessionId, sequence);`,
];

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > migrations.length) {
      this.db.close();
      throw new Error('Unsupported database version');
    }
    for (let i = version; i < migrations.length; i++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migrations[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}; COMMIT`);
      } catch (error) {
        this.db.exec('ROLLBACK');
        this.db.close();
        throw error;
      }
    }
  }

  list(): Fact[] {
    return this.db.prepare('SELECT * FROM facts ORDER BY key').all() as unknown as Fact[];
  }

  write(key: string, value: string): void {
    if (key.length > 80 || value.length > 200 || !key.trim() || !value.trim())
      throw new Error('Invalid fact');
    if (
      !this.db.prepare('SELECT id FROM facts WHERE key = ?').get(key) &&
      this.list().length >= 32
    ) {
      throw new Error('Memory limit reached');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO facts VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      )
      .run(randomUUID(), key, value, now, now);
  }

  appendEvent(event: RuntimeEvent): void {
    this.db
      .prepare('INSERT INTO events(id, sessionId, correlationId, event) VALUES (?, ?, ?, ?)')
      .run(event.id, event.sessionId, event.correlationId, JSON.stringify(event));
  }

  events(sessionId: string): RuntimeEvent[] {
    return this.db
      .prepare('SELECT event FROM events WHERE sessionId = ? ORDER BY sequence')
      .all(sessionId)
      .map((row) => JSON.parse(row.event as string) as RuntimeEvent);
  }

  close(): void {
    this.db.close();
  }
}
