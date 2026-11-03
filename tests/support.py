import sqlite3
import tempfile
from pathlib import Path


SCHEMA = """
CREATE TABLE schema_version(version INTEGER NOT NULL);
INSERT INTO schema_version VALUES(8),(9);
CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, repository TEXT,
 host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE assistant_usage_events(id INTEGER PRIMARY KEY, session_id TEXT,
 model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
 created_at TEXT, duration_ms INTEGER, time_to_first_token_ms INTEGER,
 turn_index INTEGER, agent_id TEXT, initiator TEXT, finish_reason TEXT);
CREATE TABLE turns(id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
 timestamp TEXT, user_message TEXT, assistant_response TEXT);
"""


class Fixture:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory(prefix=".tokenflow-test-", dir=Path.cwd())
        self.root = Path(self.directory.name)
        self.db = self.root / "source ? # 数据.db"
        self.connection = sqlite3.connect(self.db)
        self.connection.executescript(SCHEMA)

    def session(self, sid="s", **values):
        data = {"id": sid, "created_at": "2024-01-01 00:00:00", **values}
        columns = list(data)
        self.connection.execute(
            f"INSERT INTO sessions({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
            list(data.values()),
        )
        self.connection.commit()

    def usage(self, sid="s", **values):
        data = {
            "session_id": sid, "model": "actual-model", "input_tokens": 100,
            "output_tokens": 20, "cache_read_tokens": 80,
            "created_at": "2024-02-29T12:00:00Z", **values,
        }
        columns = list(data)
        self.connection.execute(
            f"INSERT INTO assistant_usage_events({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
            list(data.values()),
        )
        self.connection.commit()

    def turn(self, index, sid="s", text="<script>alert('x')</script>\n中文"):
        self.connection.execute(
            "INSERT INTO turns(session_id,turn_index,timestamp,user_message,assistant_response) VALUES(?,?,?,?,?)",
            (sid, index, "2024-01-01", text, text),
        )
        self.connection.commit()

    def close(self):
        self.connection.close()
        self.directory.cleanup()
