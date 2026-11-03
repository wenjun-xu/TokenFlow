import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from support import Fixture
from tokenflow.dates import Period, parse_time
from tokenflow.store import Store, StoreError


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.fixture.session()
        self.store = Store(self.fixture.db, ZoneInfo("UTC"))

    def tearDown(self):
        self.fixture.close()

    def test_formula_unknown_zero_and_actual_models(self):
        self.fixture.session("empty")
        self.fixture.usage()
        result = self.store.dashboard({})
        self.assertEqual(result["metrics"]["total_tokens"], "120")
        self.assertEqual(result["metrics"]["cache_read_tokens"], "80")
        self.fixture.usage(input_tokens=None, model="second")
        result = self.store.session("s", {})
        self.assertIsNone(result["metrics"]["input_tokens"])
        self.assertIsNone(result["metrics"]["total_tokens"])
        self.assertEqual(result["metrics"]["calls"], "2")
        self.assertEqual(len(result["models"]), 2)
        empty = self.store.session("empty", {})
        self.assertEqual(empty["metrics"]["total_tokens"], "0")

    def test_cache_unknown_does_not_change_total_and_big_integer_sum(self):
        self.fixture.usage(input_tokens=2**62, cache_read_tokens=None)
        self.fixture.usage(input_tokens=2**62)
        metrics = self.store.dashboard({})["metrics"]
        self.assertEqual(metrics["input_tokens"], str(2**63))
        self.assertEqual(metrics["total_tokens"], str(2**63 + 40))
        self.assertIsNone(metrics["cache_read_tokens"])

    def test_date_cross_day_diagnostics_and_empty_sessions(self):
        self.fixture.session("empty")
        self.fixture.usage(created_at="2024-02-28T23:59:59Z")
        self.fixture.usage(created_at="2024-02-29T00:00:00Z")
        self.fixture.usage(created_at="bad")
        self.fixture.usage(sid="orphan", created_at=None)
        result = self.store.dashboard({"year": "2024", "month": "2", "day": "29"})
        self.assertEqual(result["metrics"]["calls"], "1")
        self.assertEqual(result["session_count"], "1")
        self.assertEqual(result["diagnostics"], {"invalid_times": "2", "orphan_requests": "1"})
        self.assertEqual(self.store.dashboard({})["metrics"]["calls"], "3")
        self.assertEqual(self.store.dashboard({})["session_count"], "2")

    def test_exact_fractional_sort_and_stable_latest(self):
        self.fixture.usage(id=1, created_at="2024-02-29T12:00:00.0000009Z")
        self.fixture.usage(id=2, created_at="2024-02-29T12:00:00.0000001Z")
        self.fixture.usage(id=3, created_at="invalid")
        self.assertEqual([r["id"] for r in self.store.session("s", {})["requests"]], ["2", "1", "3"])
        self.assertTrue(self.store.dashboard({})["sessions"][0]["latest_request"].endswith(".0000009Z"))

    def test_paging_totals_lazy_body_and_no_join_multiplication(self):
        for i in range(55):
            self.fixture.usage(id=i + 1)
        for i in range(25):
            self.fixture.turn(i, text="x" * 10000)
        for i in range(23):
            self.fixture.session(f"empty-{i:02}")
        result = self.store.session("s", {"requestPage": "2", "turnPage": "2"})
        self.assertEqual(result["metrics"]["calls"], "55")
        self.assertEqual(len(result["requests"]), 5)
        self.assertEqual(len(result["turns"]), 5)
        self.assertLess(len(result["turns"][0]["user_message"]), 1000)
        tid = result["turns"][0]["id"]
        expanded = self.store.session("s", {"turnPage": "2", "expandedTurn": tid})
        self.assertEqual(len(expanded["turns"][0]["user_message"]), 10000)
        with self.assertRaises(StoreError):
            self.store.session("s", {"expandedTurn": tid})
        self.assertEqual(len(self.store.dashboard({})["sessions"]), 20)
        self.assertEqual(self.store.dashboard({"page": "2"})["session_count"], "24")

    def test_invalid_queries_schema_value_and_missing_session(self):
        for args in ({"month": "2"}, {"year": "2024", "month": "2", "day": "30"},
                     {"year": "2024", "month": "0"}, {"year": "2024", "month": "2", "day": "0"},
                     {"day": "1"}, {"year": "0"}, {"page": "0"}, {"page": "999"}, {"unknown": "x"}):
            with self.subTest(args=args), self.assertRaises(StoreError):
                self.store.dashboard(args)
        with self.assertRaises(StoreError) as context:
            self.store.session("absent", {})
        self.assertEqual(context.exception.status, 404)
        self.fixture.usage(input_tokens="not an integer")
        with self.assertRaises(StoreError):
            self.store.dashboard({})
        self.fixture.connection.execute("DROP TABLE turns")
        self.fixture.connection.commit()
        with self.assertRaises(StoreError):
            self.store.dashboard({})

    def test_refresh_and_source_unchanged(self):
        self.fixture.usage()
        before = self.fixture.db.read_bytes()
        self.assertEqual(self.store.dashboard({})["metrics"]["calls"], "1")
        self.assertEqual(self.fixture.db.read_bytes(), before)
        self.fixture.usage()
        self.assertEqual(self.store.dashboard({})["metrics"]["calls"], "2")

    def test_null_model_is_explicit_error(self):
        self.fixture.usage(model=None)
        with self.assertRaises(StoreError):
            self.store.dashboard({})

    def test_calendar_period_year_month_and_local_timezone(self):
        self.store = Store(self.fixture.db, ZoneInfo("Asia/Shanghai"))
        for value in ("2023-12-31T16:00:00Z", "2024-01-31T16:00:00Z", "2024-02-29T16:00:00Z",
                      "2024-12-31T16:00:00Z"):
            self.fixture.usage(created_at=value)
        self.assertEqual(self.store.dashboard({"year": "2024"})["metrics"]["calls"], "3")
        self.assertEqual(self.store.dashboard({"year": "2024", "month": "2"})["metrics"]["calls"], "1")
        self.assertEqual(self.store.dashboard({"year": "2024", "month": "1", "day": "1"})["metrics"]["calls"], "1")
        self.assertEqual(self.store.dashboard({"year": "2022"})["session_count"], "0")

    def test_snapshot_and_refresh_concurrent_commit(self):
        self.fixture.connection.execute("PRAGMA journal_mode=WAL")
        self.fixture.usage()
        original = Store._schema

        def schema_then_write(connection):
            versions = original(connection)
            self.fixture.usage()
            return versions

        with patch.object(Store, "_schema", side_effect=schema_then_write):
            result = self.store.dashboard({})
        self.assertEqual(result["metrics"]["calls"], "1")
        self.assertEqual(result["sessions"][0]["metrics"]["calls"], "1")
        self.assertEqual(self.store.dashboard({})["metrics"]["calls"], "2")

    def test_locked_corrupt_and_deleted_are_not_empty_success(self):
        self.fixture.connection.execute("BEGIN EXCLUSIVE")
        try:
            with self.assertRaisesRegex(StoreError, "锁定"):
                self.store.dashboard({})
        finally:
            self.fixture.connection.rollback()
        self.fixture.connection.close()
        self.fixture.db.write_bytes(b"not a sqlite database")
        with self.assertRaisesRegex(StoreError, "损坏"):
            self.store.dashboard({})
        self.fixture.db.unlink()
        with self.assertRaises(StoreError):
            self.store.dashboard({})
        self.assertFalse(self.fixture.db.exists())

    def test_fallbacks_and_deleted_session_turn_scope(self):
        result = self.store.dashboard({})
        session = result["sessions"][0]
        self.assertEqual(session["title"], "s")
        self.assertEqual(session["project"], "Unspecified")
        self.assertIsNone(session["latest_request"])
        self.fixture.session("root", cwd="/")
        self.assertEqual(self.store.session("root", {})["session"]["project"], "/")
        self.fixture.turn(2)
        self.fixture.turn(0)
        self.fixture.usage(created_at="2024-01-01T12:00:00Z")
        result = self.store.session("s", {"year": "2025"})
        self.assertEqual(result["metrics"]["calls"], "0")
        self.assertEqual([turn["turn_index"] for turn in result["turns"]], ["0", "2"])
        self.assertIn("<script>", result["turns"][0]["user_message"])
        self.fixture.connection.execute("DELETE FROM sessions WHERE id='s'")
        self.fixture.connection.commit()
        with self.assertRaises(StoreError) as context:
            self.store.session("s", {})
        self.assertEqual(context.exception.status, 404)

    def test_latest_sort_missing_last_and_stable_id(self):
        self.fixture.session("a", cwd="/some/project")
        self.fixture.session("b", repository="owner/repo", cwd="/ignored")
        self.fixture.usage(sid="a")
        self.fixture.usage(sid="b")
        result = self.store.dashboard({})
        self.assertEqual([row["id"] for row in result["sessions"]], ["a", "b", "s"])
        self.assertEqual([row["project"] for row in result["sessions"]], ["project", "owner/repo", "Unspecified"])

    def test_python_aggregation_deadline_and_malformed_performance_field(self):
        self.fixture.usage(duration_ms=1.5)
        with self.assertRaises(StoreError):
            self.store.dashboard({})
        self.fixture.connection.execute("UPDATE assistant_usage_events SET duration_ms=1")
        self.fixture.connection.commit()
        with self.assertRaisesRegex(StoreError, "超时"):
            Store(self.fixture.db, ZoneInfo("UTC"), timeout=0).dashboard({})


class DateTests(unittest.TestCase):
    def test_exact_parser(self):
        self.assertEqual(parse_time("2024-01-01 00:00:00"), parse_time("2024-01-01T01:00:00+01:00"))
        self.assertLess(parse_time("2024-01-01T00:00:00.0000001Z"),
                        parse_time("2024-01-01T00:00:00.0000009Z"))
        self.assertEqual(parse_time("2024-01-01T00:00:00.100Z"),
                         parse_time("2024-01-01T00:00:00.1Z"))
        self.assertIsNone(parse_time("2024-02-30 12:00:00"))

    def test_local_dates_dst_leap_and_historical_midnight(self):
        cases = [
            ("America/New_York", "2024-03-10", "2024-03-10T05:00:00Z", True),
            ("America/New_York", "2024-03-10", "2024-03-11T04:00:00Z", False),
            ("America/New_York", "2024-02-29", "2024-03-01T04:59:59Z", True),
            ("Asia/Shanghai", "2025-01-01", "2024-12-31T16:00:00Z", True),
            ("Pacific/Apia", "2011-12-30", "2011-12-30T10:00:00Z", False),
            ("America/Sao_Paulo", "2018-11-04", "2018-11-04T03:00:00Z", True),
            ("America/Havana", "2024-11-03", "2024-11-03T04:30:00Z", True),
            ("America/Havana", "2024-11-03", "2024-11-03T05:30:00Z", True),
        ]
        for zone, date, instant, expected in cases:
            y, m, d = date.split("-")
            with self.subTest(zone=zone, date=date, instant=instant):
                period = Period({"year": y, "month": m, "day": d}, ZoneInfo(zone))
                self.assertEqual(period.contains(parse_time(instant)), expected)


if __name__ == "__main__":
    unittest.main()
