"""Optional synthetic, isolated query baseline; never reads a user's data."""

import json
import platform
import resource
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parents[1]))

from support import Fixture
from tokenflow.query import QueryRunner
from tokenflow.store import StoreError


def main():
    results = []
    for session_count, request_count in ((1000, 10000), (1000, 100000), (10000, 1000000)):
        fixture = Fixture()
        runner = None
        try:
            fixture.connection.executemany(
                "INSERT INTO sessions(id,summary) VALUES(?,?)",
                ((f"s{i}", f"synthetic-{i}") for i in range(session_count)),
            )
            fixture.connection.executemany(
                "INSERT INTO assistant_usage_events"
                "(session_id,model,input_tokens,output_tokens,cache_read_tokens,created_at)"
                " VALUES(?,'synthetic',100,20,80,'2024-02-29T12:00:00.0000009Z')",
                ((f"s{i % session_count}",) for i in range(request_count)),
            )
            fixture.connection.commit()
            state = fixture.root / "state"
            state.mkdir(mode=0o700)
            begin = time.monotonic()
            runner = QueryRunner(fixture.db, state, ZoneInfo("UTC"))
            measurements = {}
            for name, operation, args, sid in (
                ("cold_dashboard", "dashboard", {}, None),
                ("day_filter", "dashboard", {"year": "2024", "month": "2", "day": "29"}, None),
                ("detail_last_request_page", "session",
                 {"requestPage": str(max(1, (request_count // session_count + 49) // 50))}, "s0"),
            ):
                if name != "cold_dashboard":
                    begin = time.monotonic()
                try:
                    data = runner.run(operation, args, sid)
                    expected = request_count if operation == "dashboard" else request_count // session_count
                    assert data["metrics"]["calls"] == str(expected)
                except StoreError as error:
                    measurements[name + "_error"] = str(error)
                measurements[name + "_seconds"] = round(time.monotonic() - begin, 3)
            measurements["max_child_rss_bytes"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            results.append({"sessions": session_count, "requests": request_count, **measurements})
        finally:
            if runner is not None:
                runner.close()
            fixture.close()
    print(json.dumps({
        "platform": platform.platform(), "architecture": platform.machine(),
        "python": platform.python_version(), "synthetic_benchmark": results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
