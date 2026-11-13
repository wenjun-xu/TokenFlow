# TokenFlow Technical Design 2: Python Standard-Library Service and Homebrew Tap

> Historical design: v0.1.0 was publicly prereleased using this design. The user now selects
> a TS + Bun standalone executable; Python product code from this design is no longer maintained,
> while old releases remain available. See [TECHNICAL_DESIGN_TYPESCRIPT.md](TECHNICAL_DESIGN_TYPESCRIPT.md)
> and [`../README.md`](../README.md) for the current design and usage.

## 1. Requirements Understanding and Conclusion

Based on [REQUIREMENTS.md](REQUIREMENTS.md) and [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md). At the time of this design, the user's selection had moved this plan into Python implementation, with a self-managed Homebrew tap chosen but not yet publicly released. Defaults from requirements Section 2.3 remain, and dates filter by request occurrence.

The product is a local read-only Copilot usage analyzer. After installation, `tokenflow start` launches a background service and opens the browser. Home provides year/month/day filters, totals, and pagination. Details show session metadata, period/all-time usage, model totals, requests, and existing conversations. `tokenflow stop` stops this tool.

No model calls, monetary conversion, log parsing, cloud synchronization, inferred per-turn tokens, or database changes. Old `tokenboard` and log logic in the structural reference are historical context, not reusable current implementation or permission to expand scope.

**Selected conclusion**: Use Python's standard library and install via `brew install wenjun-xu/tap/tokenflow`. Homebrew manages Python and the tool's isolated environment without manual Python installation. Do not use PyInstaller or build dual-architecture interpreter application bundles. Retain TypeScript as an alternative, not a parallel implementation.

## 2. Stack and Minimal Structure

| Layer | Choice | Reason |
|---|---|---|
| CLI | `argparse` | Standard library covers commands |
| HTTP | `http.server.ThreadingHTTPServer` plus narrowly scoped custom routes | Local closed-use service without FastAPI/Uvicorn |
| Data | `sqlite3`, `int`, `datetime`, `zoneinfo` | Direct read-only SQLite and exact integers |
| Background process | `subprocess`, `fcntl`, `socket` | Native session detachment, file locks, Unix sockets |
| Pages | Bundled HTML/CSS/native JavaScript | No Node, frontend framework, or CDN |
| Distribution | Source archive, SHA-256, Homebrew tap | Homebrew manages Python 3.13 and installs a zero-runtime-dependency tool into a pip-free isolated environment |

Code supports CPython 3.11+, while the formula explicitly depends on Homebrew Python 3.13 rather than macOS system Python. With no third-party Python runtime dependencies, the formula creates a pip-free virtual environment using the standard library and installs package files; `pyproject.toml` also supports conventional Python installation. `http.server` is not a public-facing production server: loopback binding, fixed routes, explicit validation, and authentication define this project. Expanding to network service requires reevaluation, not merely changing the bind address.

```text
tokenflow/__main__.py    CLI and internal service entry
tokenflow/cli.py         Arguments and browser entry
tokenflow/lifecycle.py   Lock, state, background process, control socket
tokenflow/dates.py       Exact timestamp parsing and local calendar filters
tokenflow/store.py       Compatibility, snapshots, time, metrics
tokenflow/server.py      Fixed routes, authentication, errors
tokenflow/query.py       Controlled query subprocess entry
tokenflow/web/           index.html, app.js, style.css
tests/                  Synthetic databases and lifecycle checks
scripts/prepare_release.py  Source archive, checksums, matching formula
```

No ORM, dependency-injection container, second database, plugin system, or multi-service orchestration.

## 3. Data Reads, Precision, and Dates

### 3.1 Database Access

- Default to `~/.copilot/session-store.db`. Verify existence, normalize with `Path.resolve()`, and use safe URI encoding such as `Path.as_uri()` plus `mode=ro` so spaces and `?` cannot become extra parameters. Do not create absent databases.
- Use `sqlite3.connect(..., uri=True)`, `PRAGMA query_only=ON`, and finite `timeout`. One connection per query subprocess, never shared across threads. Initially allow at most one query at a time with bounded short waits and an explicit 503 when busy.
- Inspect every `schema_version` row and required fields. Do not assume one row or reject extras. Distinguish missing structures, unsupported field types, permissions, and corruption with clear errors/remedies.
- Each page API explicitly begins one short read transaction, reading totals, lists, current-page content, and diagnostics together; commit/roll back and close before serialization. Multiple connections across threads are not “one snapshot.”
- Read only the four specified tables. No migrations, indexes, journal-mode changes, main-file-only copies omitting WAL, or `immutable=1`. Read-only flags do not prevent every sidecar creation; use OS isolation below to prohibit source-directory writes. Fail explicitly when WAL/SHM cannot be accessed read-only.
- Each page query runs through the same application's internal query subprocess, with parameters/results on private pipes and no content scratch files. `set_progress_handler` supports SQLite cancellation; Python iteration checks deadlines too. The parent supervises the full task, including aggregation, sorting, serialization, and IPC. On timeout, terminate and wait for its own `Popen` child, force-ending only that still-unreaped child after a grace period. Never act on an unknown process from a stale state PID. The OS releases connections/locks on exit; return an explicit error and release the task slot.
- Enable Seatbelt isolation via macOS `/usr/bin/sandbox-exec` before opening databases for every check/query. Query children deny all file writes and return results through pipes; the parent writes only its own state. If sidecars disappear after checking, the OS prevents recreation rather than relying on a racy existence check. Use existing readable WAL/SHM; fail explicitly if writes are required.
- `sandbox-exec` is deprecated. First verify supported OS versions, both architectures, and PyInstaller program execution as noted in the original design, along with actual isolation and active WAL reads. Refuse reads if unavailable, with no silent fallback; resolve isolation or confirm changed requirements before claiming AC-15. Include one-child-per-page overhead in the baseline without prebuilding a pool.

### 3.2 Metrics and Response Format

Use the same accumulator for home, details, and model groups: count requests individually and track sums plus NULL flags for input, output, and cache. Python arbitrary-precision `int`, not floats or SQLite `SUM`, prevents overflow and loss of unknowns.

```text
Field total = 0                         Empty request set
Field total = Unknown                   A NULL exists in that field in a nonempty set
Field total = Exact sum of all integers  Otherwise
Total tokens = Input + Output           Only when both are known
```

Display cache reads separately, never adding them again. Unknown cache does not affect known input plus output. `cache_write_tokens`, `reasoning_tokens`, AIU, and multipliers do not enter token totals or monetary conversion. Noninteger token anomalies fail explicitly, without coercion, omission, or zero substitution.

Home first loads lightweight sessions, then iterates required request fields by actual session/model. No content reads and no requests × turns JOIN. Memory grows with session/model groups, not every request's content.

Encode integer counts, IDs, and tokens as decimal strings in APIs; unknown metrics are `null`. Frontend formatting inserts thousands separators into strings without converting to `Number`, preserving values beyond JS safe-integer range.

### 3.3 Local Time and Anomalous Attribution

A shared parser supports SQLite timestamp text and ISO 8601 `Z`/offset timestamps. Timezone-less values are UTC. Preserve and flag invalid/unsupported originals; never filter with `[:10]` or substitute session timestamps.

`datetime` microsecond precision is not source precision. Retain original fractional seconds separately, convert UTC integer seconds with `datetime`/`calendar`, and strip trailing fractional zeros only (zero becomes `""`). Compare exact `(UTC integer seconds, fractional digit string)` keys; binary lexicographic order handles arbitrary fractional digits within a second without float conversion. Register two SQLite scalar functions returning INTEGER seconds and TEXT fraction with explicit `COLLATE BINARY`. Use the same key for home latest requests, dates, and request pagination without microsecond truncation.

At macOS startup, read system time-zone configuration: prefer the identifier resolved from `/etc/localtime` and load it with `ZoneInfo`; if needed, use `ZoneInfo.from_file()` on the system file with an explicit source label. Do not treat the current fixed UTC offset as a year-round zone. Fail startup if no valid local zone is available; capture it at service startup and require restart after changes.

The actual implementation converts every request's exact UTC integer second into a local civil date and matches selected year/month/day directly. This equals membership in local calendar periods without constructing potentially nonexistent/duplicate midnight boundaries or fixed 24-hour spans. Fractions remain for exact sorting. Test historical midnight transitions, skipped dates, and ordinary DST.

All-time includes sessions without requests and requests with anomalous timestamps. Period queries include only sessions with locatable in-period requests. Do not invent sessions or include orphan requests in home totals. Both diagnostics count database-wide with scope labels; anomalies and orphans can overlap, so their sum is not a unique-record count. Year options derive from parseable requests' local years.

## 4. APIs and Page Interaction

| API | Response |
|---|---|
| `GET /api/dashboard?year=&month=&day=&page=` | Full-range metrics, 20 sessions, total count, years, time zone, diagnostics, read time |
| `GET /api/sessions/{id}?year=&month=&day=&requestPage=&turnPage=` | Basic information, range totals, model groups, 50 requests, 20 whole-session turns and counts, diagnostics, read time |

Each API guarantees consistency within one response. Manual refresh sees new commits, without promising different HTTP requests always share a database version. Every SQL value uses placeholders; routes and sort fields are fixed, never generated by concatenating user input.

Reject month without year, day without month, invalid dates, and invalid pages server-side. 404 means no session; database failures return structured non-2xx errors rather than success-shaped empty arrays. Out-of-range pages suggest a valid page.

Lists sort latest valid in-range request descending, missing last, then stable ID. Detail requests sort valid time/ID ascending with anomalies last. `sqlite3.create_function` registers the shared parser's sort keys; `LIMIT/OFFSET` retrieves request pages, with separate streaming totals. Do not send every request to the browser. Turns order by `turn_index`.

Return content previews by page. The detail API's `expandedTurn` adds full content for one specified current-page turn, after validating session/page ownership and explicitly handling deletion. Default collapse must not merely hide already downloaded long content in CSS.

Frontend URLs preserve filters/pages; details inherit the period. “View all time” and “Restore original period” switch explicitly; return preserves the original page. Conversations always say “Recorded conversation for the entire session,” independent of request dates and without guessed associations or per-turn tokens.

Home displays all specified metrics, created/latest-request times, actual model lists, and project fallbacks. Details include full metadata and per-request duration, TTFT, agent, original turn index, initiator, and finish reason. Empty summaries use abbreviated IDs; project falls back `repository → cwd → Unspecified`. Missing basic fields show “Not recorded”; missing latest request is “—.”

Use native accessible forms, links, and buttons; all content uses `textContent`, preserving line breaks without interpreting HTML. Shared `fetch` handling covers loading/empty/failure. Query resets to page one; refresh preserves conditions. Retained old data is marked stale with last successful read time; disconnection suggests `tokenflow start`. No automatic polling.

## 5. Background Lifecycle and Access Control

### 5.1 start

1. Use current-user state at `~/Library/Application Support/TokenFlow/`, directory mode 0700, files 0600. Verify ownership and reject unsafe symlinks.
2. `fcntl.flock` guarantees one instance per user. The parent explicitly passes the lock FD with `pass_fds` so the service holds it until exit. Concurrent starts wait boundedly and cannot publish two instances.
3. Launch internal service mode via `subprocess.Popen`, `start_new_session=True`, stdin `DEVNULL`, stdout/stderr in the tool's own logs. No shell strings or assumptions that the terminal remains open.
4. The child verifies the database, binds `127.0.0.1:0`, creates a private Unix socket, and atomically publishes instance identity, canonical database path/file identity, port, and diagnostic PID. Readiness is negotiated through control, with a parent startup deadline.
5. Reuse a healthy same-source instance; another source requires stop. Path aliases are not different databases, while a replaced file at the same path prompts an explicit warning rather than switching silently.
6. Once ready, invoke `open`. Browser failure keeps service running with a warning/manual URL. Startup failure acts only on the attempt's own `Popen` child/resources and exits nonzero, never signaling a state-file PID.

### 5.2 stop

Control uses the current user's private Unix socket and per-instance random identity, never an HTTP shutdown route. Shutdown stops accepting work, cancels outstanding queries, releases database/HTTP/lock resources, and exits after main-thread cleanup.

Call `ThreadingHTTPServer.shutdown()` from a thread other than `serve_forever` to avoid deadlock. HTTP threads handle only bounded network/pipe IO, not uninterruptible large sorts. The control thread initiates shutdown and terminates/reaps every registered query child, with network/thread deadlines. Report success only after listener and lock are released; timeout returns nonzero rather than false success.

No instance is idempotent success. Clean stale state only while holding the instance lock and confirming no active service. An occupied lock with unavailable control is failure. Do not kill based only on an old PID, close browser/Copilot, or delete source data.

### 5.3 Local Web Security

- Strict Host match to current `127.0.0.1:<port>`; any Origin must match. Reject cross-site Fetch Metadata and do not enable CORS.
- Generate a high-entropy per-instance key, delivered in startup URL fragment. Immediately remove the fragment, store it in the tab's `sessionStorage`, and use a custom API authentication header. Validate keys even without Origin; static shells contain neither keys nor business data.
- Manual URLs include credentials, appear only in the user's terminal, and are never logged. New tabs require the full startup URL or another start. Shutdown does not depend on browser keys.
- Fixed static allowlist, no path-traversal routing. Bound request size, headers, and processing time; reject unknown methods/routes. Restrictive CSP, anti-framing, `no-referrer`, and sensitive-response `no-store`.
- No CDN, telemetry, remote fonts, or third-party requests. Logs contain operations, codes, and necessary diagnostics, not messages, keys, or full URLs. Malicious processes under the same OS user are outside guaranteed isolation.

## 6. Implementation Steps, Checks, and AC Mapping

| Step | Work | Acceptance criteria |
|---|---|---|
| P1 | Synthetic databases, read-only compatibility, shared metrics, integer API contracts | AC-08, 09, 10, 14, 15 |
| P2 | Time zones, date validation, calendar boundaries, anomaly/orphan diagnostics | AC-05, 06, 07, 14 |
| P3 | Snapshot APIs, session/request/turn pagination, on-demand content | AC-10, 11, 12, 13, 18 |
| P4 | Native English pages, range switching, return navigation, refresh, errors | AC-05, 11, 12, 13, 14, 17, 18 |
| P5 | Background service, locks/readiness, reuse, shutdown, browser feedback | AC-02, 03, 04, 16 |
| P6 | Source archives, Homebrew formula, clean installation on both architectures | AC-01, 02, 15, 17 |

Automated checks use standard-library `unittest`: `python3 -B -m unittest discover -s tests -v`, without pytest. Development checks have covered synthetic databases, actual macOS isolation, and lifecycle; record independent verification and release-environment acceptance separately rather than treating local checks as proof of public installation.

Synthetic scratch databases cover: 100/20/80 yielding 120, NULL/zero, values beyond JS precision and large accumulations, one-to-many requests/turns, dates and cross-day sessions, leap days/DST/historical midnight changes, anomalous times, orphan requests, compatibility errors for empty model data, missing tables/fields, lock timeouts, deletion, and out-of-range pages. Concurrent writes verify one-response snapshots and refresh seeing new commits. ID 1 at `.0000009Z` and ID 2 at `.0000001Z` must order 2 then 1; pagination and home latest requests preserve this precision.

In writable source directories, test WAL without sidecars, active sidecars, and upstream concurrent sidecar removal/recreation: correct reads or explicit failures only; the tool creates no source files. Trigger timeout and stop during Python sorting/serialization after the last SQLite step and verify task termination plus transaction/connection/port/lock release, not just SQL timeout.

macOS integration checks cover simultaneous starts, survival after terminal exit, different databases, spaces/special characters in paths, browser failure, child startup failure, stale PID pointing to an unrelated process, and released port/lock after stop. Browser checks cover plain-text scripts, absent keys, forged Host/Origin, inaccessible cross-site shutdown, keyboard operation, and complete offline assets.

## 7. Packaging, Releases, and Performance Tradeoffs

### 7.1 Homebrew-Managed Python Distribution

Planned project repository: `wenjun-xu/TokenFlow`; tap: `wenjun-xu/homebrew-tap`.
One `brew install wenjun-xu/tap/tokenflow` installs without a prior `brew tap`
or inclusion in the official Homebrew repository.

`scripts/prepare_release.py` generates a versioned source archive with fixed timestamps,
SHA-256, and a formula using the archive's actual checksum. Upload that exact archive to
the matching GitHub Release, then publish the formula to the tap; local generation does not publish.
Script parameters can change repository names. Minimum macOS, clean-machine checks on both
architectures, and licensing must be settled before public release.

The formula depends on `python@3.13`, creates an isolated environment under `libexec`
with standard-library `venv --without-pip`, installs package/static assets, and provides
`bin/tokenflow`. No third-party runtime dependencies, pip, PyInstaller, embedded-interpreter
archives, or manually signed interpreter dynamic-library bundles are needed.

Background/query children use that environment's `sys.executable -m tokenflow`; pages are
located as package resources, independent of the user's working directory. Homebrew provides
architecture-appropriate Python, but TokenFlow must still verify SQLite, WAL, time zones,
isolation, and lifecycle on arm64 and x86_64; pure Python source is not dual-architecture
acceptance. Run `tokenflow stop` before upgrading or uninstalling.

### 7.2 Performance Limits and Upgrade Conditions

Python timestamp callbacks and aggregation incur interpreter overhead, but do not claim performance superiority/inferiority versus TypeScript/Bun without measurements. With no source time index and no source modifications allowed, first use streaming request scans and lightweight in-memory groups, not content scans or a cached entire database.

Use synthetic tiers of 1,000/10,000 sessions and 10,000/100,000/1,000,000 requests to measure cold start, home, day filters, details, deep OFFSET pages, peak memory, and transaction duration, then verify authorized deidentified samples. No measured results currently establish maximum scale or response targets.

Initially bound read concurrency, lock waits, and whole-task deadlines. Exceeding limits must fail explicitly, not truncate requests and return seemingly complete metrics. Query children serve complete-task cancellation and read-only isolation, not extra resident services. Discuss derived state-directory caches or focused optimizations only after real bottlenecks, without prebuilt background indexers, process pools, or incremental sync chains.

## 8. Constraint Assessment and Design Comparison

Originally greenfield document design, this plan now has a `tokenflow/` implementation and synthetic `tests/`. P-1/P-3 use standard-library/native page controls; P-2 reuses four source tables without adding business tables.

NFR rules/convention cards inform avoidance of N+1, short transactions, explicit errors, and redacted logs. Do not copy Java/PostgreSQL/Vue stack requirements, enterprise log retention, or source-index additions. Scans and OFFSET are explicit read-only/pagination tradeoffs requiring measured upper bounds.

| Dimension | TypeScript/Bun | Python |
|---|---|---|
| Package | One executable per architecture | Universal Python source archive plus Homebrew formula |
| User runtime | Embedded Bun, macOS system SQLite | Homebrew installs Python automatically, no manual configuration |
| Development focus | bigint, synchronous-query isolation, system management | Standard-library data logic, thread shutdown, read-only isolation |
| Precision | `bigint`, with safe-integer driver mode enabled | Built-in `int` |
| Performance expectations | Compiled bundle is not equivalent to native machine code; scans need measurement | Interpreter callback/aggregation overhead needs measurement |
| Preferred when | Team knows TS and wants one language and file distribution | Team knows Python and wants quick rule validation |

Both designs share scope and ACs. Do not gain shorter code by omitting security, read-only protection, NULL handling, or background persistence. Before implementation, jointly confirm defaults, supported Copilot versions, authorized samples, release ownership, and performance boundaries. Unverified upstream semantics remain unknown.
