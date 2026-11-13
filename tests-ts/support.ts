import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA = `
CREATE TABLE schema_version(version INTEGER NOT NULL);
INSERT INTO schema_version VALUES(8),(9);
CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,repository TEXT,host_type TEXT,
 branch TEXT,summary TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE assistant_usage_events(id INTEGER PRIMARY KEY,session_id TEXT,model TEXT,
 input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,created_at TEXT,
 duration_ms INTEGER,time_to_first_token_ms INTEGER,turn_index INTEGER,agent_id TEXT,
 initiator TEXT,finish_reason TEXT);
CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id TEXT,turn_index INTEGER,timestamp TEXT,
 user_message TEXT,assistant_response TEXT);`;

export class Fixture {
  root = resolve(import.meta.dir, ".f-" + randomUUID().slice(0, 8));
  db = join(this.root, "source ? # \u6570\u636e.db");
  state = join(this.root, "state");
  connection: Database;
  constructor() {
    mkdirSync(this.root, { mode: 0o700 });
    mkdirSync(this.state, { mode: 0o700 });
    this.connection = new Database(this.db, { create: true, safeIntegers: true });
    this.connection.exec(SCHEMA);
  }
  insert(table: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    this.connection.query(`INSERT INTO ${table}(${keys}) VALUES(${keys.map(() => "?")})`).run(...Object.values(data));
  }
  session(id = "s", values = {}) {
    this.insert("sessions", { id, created_at: "2024-01-01 00:00:00", ...values });
  }
  usage(values = {}) {
    this.insert("assistant_usage_events", {
      session_id: "s", model: "actual-model", input_tokens: 100n, output_tokens: 20n,
      cache_read_tokens: 80n, created_at: "2024-02-29T12:00:00Z", ...values,
    });
  }
  turn(turn_index = 0, text = "<script>alert('x')</script>\n\u4e2d\u6587", session_id = "s") {
    this.insert("turns", { session_id, turn_index, timestamp: "2024-01-01",
      user_message: text, assistant_response: text });
  }
  close() {
    this.connection.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
