# TokenFlow Technical Design 1: TypeScript + Bun Standalone Executable

> Currently selected design: v0.2.0 migrates to a precompiled TS + Bun standalone executable.
> The original design follows. The actual implementation reuses v0.1.0's `flock` and private
> socket protocol for safe migration of old instances, rather than launchd; dates use strict
> parsing and Intl with an explicit system time zone, without a Temporal runtime dependency.
> Page assets are embedded and Homebrew no longer installs Python, Node.js, or Bun.
> [`../README.md`](../README.md) is authoritative for usage, measured support, and releases;
> cross-compilation does not constitute native Intel acceptance.

## 1. Requirements Understanding and Recommendation

Based on [REQUIREMENTS.md](REQUIREMENTS.md) and [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md). This work delivers a technical design only, not an implementation or published installation source. The draft defaults in requirements Section 2.3—macOS, request occurrence dates, manual refresh, one instance per user, and an English interface—still require confirmation before implementation.

**The product**: Install a CLI tool; `tokenflow start` runs a local background service and opens the browser. Home displays Copilot request usage and sessions by year/month/day; details show model totals, request records, and existing database conversations. `tokenflow stop` stops the tool safely.

This is neither a new AI invocation tool nor a billing platform. The first version does not read `events.jsonl`, estimate costs, infer per-turn tokens, upload data, or modify the Copilot database. The old `tokenboard` in the schema reference is source context, not existing project code.

**Recommendation**: Between Python and TypeScript, prefer TypeScript + Bun when a unified frontend/backend language and simpler user installation matter most. Choose the [Python design](TECHNICAL_DESIGN_PYTHON.md) when the team is more familiar with Python and prioritizes validating statistical rules. Both designs have the same feature scope; do not maintain both in the first version.

## 2. Stack and Minimal Structure

| Layer | Choice | Reason |
|---|---|---|
| CLI and HTTP | TypeScript, Bun, `Bun.serve` | Fixed routes suffice without CLI/web frameworks |
| SQLite | Built-in `bun:sqlite` | No ORM or user-installed database tools |
| Exact statistics | `bigint`, explicit unknown markers | No dependence on floating-point or SQLite SUM overflow behavior |
| Time | `@js-temporal/polyfill` | Correct time zones, calendar boundaries, and strict dates without handwritten DST algorithms |
| Pages | HTML, CSS, a small amount of TypeScript compiled to JavaScript | No React/Vue, CDN, or separate frontend server |
| Background lifecycle | macOS `launchd` / `launchctl` | Native single-instance/process management rather than custom PID supervision |
| Release | `bun build --compile`, two architecture archives, SHA-256, Homebrew tap | Users need no preinstalled Bun, Node, or development environment |

Select a stable Bun release verified during implementation and lock runtime/build dependencies. Compiling a Bun executable does not check TypeScript types; run `tsc --noEmit` separately. Do not use experimental AOT compilation.

Bun uses system SQLite by default on macOS, so “standalone executable” does not mean SQLite is independent of the OS. Check actual SQLite capabilities at startup and verify the minimum supported macOS; do not require another Homebrew SQLite in the first version.

```text
src/cli.ts              Command parsing, start/stop, browser entry
src/lifecycle.ts        launchd, state, private control socket
src/server.ts           HTTP routes, authentication, errors
src/query.ts            Internal query subprocess entry
src/store.ts            Read-only queries, metrics, time rules
web/                    index.html, app.ts, style.css
tests/                  Synthetic databases and lifecycle checks
```

Separate responsibilities by file without microservices, plugin layers, generic repository interfaces, or another database. The only runtime npm dependency is the time polyfill: date boundaries are explicit acceptance requirements, not something to replace with a few imprecise `Date.parse` lines.

## 3. Data Reads and Exact Statistics

### 3.1 Compatibility, Read-Only Access, and Snapshots

1. Default to `~/.copilot/session-store.db`. Verify existence, permissions, and canonical path before opening with `readonly: true`, `create: false`, and `strict: true`. Pass a file path rather than constructing unescaped URI parameters.
2. Read all actual `schema_version` values and `PRAGMA table_info`; assess required fields in the four used tables and actual data capabilities. Schema 8 is the reference, not the sole compatibility condition; extra fields are allowed.
3. Do not migrate, add indexes, alter journal mode, copy only the main file and omit WAL, or use `immutable=1`. Read-only flags alone do not prevent coordination sidecar creation, so all checks/queries run under OS file-write isolation as described below. Fail explicitly if existing WAL/SHM cannot be read correctly; do not ignore WAL.
4. One page read uses an explicit short read transaction on the same connection. Read totals, lists, diagnostics, and current-page content, end the transaction immediately, then generate the response. Do not `await` inside the transaction, which could cause Bun's synchronous transaction wrapper to commit prematurely.
5. Use a finite `busy_timeout`, query deadline, and bounded queue. Roll back on any failure and return a non-2xx error; never convert incompatibility, permission failures, or lock timeouts into empty arrays.

### 3.2 Keeping Synchronous SQLite from Blocking the Service

`bun:sqlite` is synchronous. To remain responsive to shutdown and network requests during reads, the HTTP main process does not run large scans directly. It invokes the same executable in internal query mode, passing parameters and JSON results through private pipes, without exposing internal mode over HTTP.

The first version allows at most one query subprocess at a time. Others wait briefly in a bounded queue; overflow returns a busy message. Each task has its own read-only connection/transaction. On timeout or shutdown, the main process may terminate **the still-unreaped query subprocess handle it created**, releasing OS file locks; never kill a PID taken from state. Include subprocess startup overhead in the baseline; do not prebuild a process pool.

Only potentially blocking SQLite work is isolated; no extra service is introduced. Content and access keys never enter command-line arguments, logs, or temporary files; use private pipes for input.

The query subprocess loads the tool's Seatbelt profile through macOS `/usr/bin/sandbox-exec`: deny file writes except to its own state directory. The source database and sidecars must not be inside any writable exception. Enable isolation before any database is opened to cover creation races rather than checking sidecars beforehand. SQLite may use existing WAL/SHM that support read-only access; if a write is required, the OS denies it and the tool reports a clear error.

This deprecated OS interface is an explicit release risk; do not assume future macOS versions support it. T1 must verify isolation, Bun execution, readable active WAL, and no sidecar creation on both architectures and minimum/maximum supported OS releases. Refuse reads when the interface is unavailable or isolation cannot be verified; do not silently fall back to ordinary read-only flags. If a target platform cannot meet the requirement, adjust isolation or confirm changed boundaries before implementing the product; do not claim AC-15 is satisfied.

### 3.3 Shared Metrics and Precision

Use one shared accumulator for home, session, and model statistics. For each field, track its exact sum and whether NULL was encountered; count requests independently.

```text
Empty request set: input/output/cache/total tokens = 0; calls = 0
Nonempty set: a NULL in a field makes that field's total unknown
Total tokens: add input and output only when both are known; exclude cache reads
```

Enable `safeIntegers: true` and read integers as `bigint`, not as `number` converted afterward. Report violations of integer contracts explicitly; never coerce, ignore, or substitute zero. Unknown cache does not affect known input plus output; cache writes, reasoning, AIU, and multipliers do not contribute to total tokens or monetary conversion.

Do not serialize bigint directly to JSON. Encode counts, IDs, and tokens as decimal strings; unknown metrics are `null`. Format thousands separators from strings in the frontend to preserve values above `2^53-1`.

Home reads lightweight session metadata, then iterates required request fields and accumulates by actual session/model. No content reads and no requests × turns JOIN. Memory grows mainly with session/model groups rather than storing every request.

## 4. Dates, Lists, and Anomalous Attribution

- One strict parser supports timezone-less SQLite timestamps and ISO timestamps with `Z`/offsets. Treat timezone-less values as UTC. Preserve originals and flag empty, invalid, or unsupported formats; do not substitute session timestamps.
- Initialize Temporal with the system local time-zone identifier, fix it at startup, and display it. Do not save only the current UTC offset. Restart after system time-zone changes; fail startup if no valid local zone can be obtained.
- Validate dates with `Temporal.PlainDate` and reject overflow. Obtain the real start of the selected date and next calendar period in that zone for inclusive-start/exclusive-end intervals, not fixed 24-hour spans. Cover DST, midnight offset changes, and skipped civil dates.
- All-time results include sessions without requests and requests with anomalous timestamps. Date filters retain sessions with requests in the period. Do not invent sessions for orphan requests or include them in home totals. Count both diagnostic categories database-wide, label their scope and possible overlap, and do not simply add them.
- Year options come from parseable requests' local years. Disable month/day without year and day without month; changing a parent clears children. Server-side validation also rejects month without year, day without month, February 30, and invalid page numbers.
- Home orders latest valid in-range requests descending, missing values last, then session ID for stability. All-time sessions whose every request timestamp is anomalous remain visible.
- Detail requests order by actual instant ascending, anomalies last, then ID ascending. Register the shared parser as SQLite scalar functions returning integer seconds and within-second nanoseconds to avoid JavaScript millisecond ordering loss. Use LIMIT/OFFSET for the current page and a separate streaming pass for detail totals.

## 5. Pages and APIs

| API | Single-response contents |
|---|---|
| `GET /api/dashboard?year=&month=&day=&page=` | Time zone, year options, range, all matching metrics, total sessions, 20 sessions, diagnostics, successful read time |
| `GET /api/sessions/{id}?year=&month=&day=&requestPage=&turnPage=` | Basic information, period totals, model totals, 50 requests, 20 whole-session turns, independent counts, diagnostics, successful read time |

Use placeholders for every SQL value, with fixed routes and sort fields. Missing sessions return 404; out-of-range pages suggest a valid page rather than appearing as read failures. Update read time only after a complete successful snapshot.

Always label conversation “Recorded conversation for the entire session”; sort by `turn_index`, independent of request dates and without inferred attribution. Return only current-page previews by default. Expansion uses the detail API's `expandedTurn` parameter for one specified turn's full content on that page, validating session/page ownership and explicitly handling deletion. Do not download all long content in advance and merely hide it with CSS.

URLs preserve filters/pages and details inherit the period. “View all time” and “Restore original period” switch explicitly; returning restores original parameters. Refresh keeps filters; query/reset return to page one.

Show all specified fields: basic metadata, actual model list, input/output/total/cache, duration, first-token latency, original `turn_index`, agent, initiator, and finish reason. Do not interchange `output_ttft_ms` or interpret original indices as verified associations.

Summary falls back to abbreviated ID; project uses `repository → cwd → Unspecified`. Missing basic fields are “Not recorded,” missing latest request is “—,” and unknown tokens differ from zero. Render all content with `textContent`, preserving line breaks without interpreting source HTML.

Use native accessible forms, links, and buttons. Shared fetch handling covers loading, empty data, and failure. Retained old data is labeled “Data is stale” with last successful time. On disconnection, suggest the service may have stopped and `tokenflow start`; polling or push is not required.

## 6. Background Lifecycle and Local Security

### 6.1 Native macOS Management

Use the current user's `~/Library/Application Support/TokenFlow/`, directory mode 0700 and file mode 0600; validate ownership and reject unsafe symlinks. A fixed user-domain launchd label prevents duplicate registration.

`start` first verifies an existing instance's identity through its private Unix socket. Reuse the same database; require shutdown before another. Canonical paths and file identity recognize aliases and replacement files without silent source switching.

With no instance, register the controlled service via launchctl bootstrap in `user/<uid>`, then kickstart it. Do not use `-k` to restart existing instances. Keep the plist in the state directory, not an automatic login-load directory; disable `RunAtLoad` and `KeepAlive`, with no login autostart. Program paths/arguments are arrays, not shell strings. A losing concurrent bootstrap reads/waits for the winner without overwriting its parameters or state.

First verify atomic configuration publication under concurrent launchctl registration: competitors write independent read-only candidate plists and compete atomically for the same label. Another candidate must not alter the registered task's ProgramArguments; losers remove only their own files.

The service binds `127.0.0.1:0`, creates a private control socket, and atomically publishes port, random instance identity, and source identity. After readiness verification, the parent CLI prints the URL and invokes macOS `open`. Browser failures keep the service running and provide a manual URL. Startup has a deadline; cleanup may reclaim only launchd tasks/resources confirmed to belong to that attempt, never another concurrent start's successful instance.

### 6.2 Shutdown and Stale-State Recovery

`stop` authenticates through the permission-controlled Unix socket and requests graceful shutdown. The main process stops accepting work, cancels its own query processes, closes HTTP, and removes its state. The CLI waits for shutdown, then removes the identity-verified launchd registration so a later start may choose a new database.

A concurrent start during shutdown waits for verified old registration cleanup before competing, rather than restarting the stopping task. If control fails, bootout is permitted only after verifying the registered program path, instance arguments, and controlled configuration. If verification fails, return nonzero. Never kill the PID directly from state.

No service and no valid registration is idempotent success. Explicitly inspect/clean stale registration and abnormal exits rather than treating file existence as health. Measure GUI/user domain availability and launchctl return semantics on target macOS; system management is not an unverified reliability guarantee.

### 6.3 Browser Security

- Require Host to equal current `127.0.0.1:<port>`; any Origin must match. Reject cross-site Fetch Metadata and do not enable CORS.
- Pass a high-entropy per-instance key via startup URL fragment, immediately remove it from the address bar, and store it in the current tab's sessionStorage. APIs require a custom authentication header even without Origin. Static shells contain no key or business data.
- Manual URLs contain credentials and appear only in the user's terminal, not logs. New tabs need the full URL or another start. HTTP has no shutdown route; browser keys cannot stop the service.
- Restrictive CSP, anti-framing, `no-referrer`, and sensitive-response `no-store`; fixed static-asset allowlist, all embedded, without remote fonts or telemetry.
- Error logs contain operation/error codes, not conversations, keys, database content, or full URLs. Write only to the state directory. Malicious programs under the same OS user are outside guaranteed isolation.

## 7. Implementation Steps and Acceptance Mapping

| Step | Work | Acceptance criteria |
|---|---|---|
| T1 | Synthetic database, read-only compatibility, bigint/NULL metrics, API type contracts | AC-08, 09, 10, 14, 15 |
| T2 | Temporal parsing, calendar ranges, sorting, anomaly diagnostics | AC-05, 06, 07, 14 |
| T3 | Query isolation, snapshot APIs, model groups, pagination, on-demand content | AC-10, 11, 12, 13, 18 |
| T4 | English pages, stateful navigation, range switching, refresh, errors | AC-05, 11, 12, 13, 14, 17, 18 |
| T5 | launchd single instance, readiness, reuse, shutdown, browser failures | AC-02, 03, 04, 16 |
| T6 | Both architecture packages, checksums, Homebrew formula, clean-machine acceptance | AC-01, 02, 15, 17 |

Planned checks: `bunx tsc --noEmit` and `bun test`; lifecycle/release acceptance runs on macOS. This design work did not implement an engineering project or execute these commands; they are not pass evidence.

Synthetic samples cover: 100/20/80 yielding 120, NULL versus empty sets, values beyond JS precision and large sums, no duplication across requests/turns, cross-day sessions, leap days, UTC midnight, 23/25-hour DST days, historical midnight changes, anomalous times, orphan requests, missing tables/fields, lock timeouts, page boundaries, and session deletion. Concurrent writes verify single-response consistency and refresh seeing new commits. Also test WAL with no sidecars, existing active sidecars, and upstream concurrent sidecar deletion/recreation in writable source directories: reads must either succeed correctly or fail explicitly; TokenFlow must not create files there.

Lifecycle checks include survival after terminal exit, competing starts, start/stop races, different databases, browser failure, crashes/stale registrations, unrelated PIDs unharmed, query timeout, and port release. Security checks cover plain-text scripts, absent keys, forged Host/Origin, inaccessible cross-site shutdown, keyboard operation, and no external requests.

## 8. Performance, Release Risks, and Constraints

Only structural references are available, with no authorized performance samples, so do not promise scale or millisecond timings. Start with synthetic tiers of 1,000/10,000 sessions and 10,000/100,000/1,000,000 requests. Measure cold start, home, day filtering, details, deep pagination, subprocess overhead, peak memory, and transaction duration. Then verify with authorized deidentified real samples and state supported scale.

The source lacks a request-time index and cannot be modified. First use metadata scanning, streaming aggregation, and lightweight session groups, approximately O(request count + session sorting). Measure deep OFFSET and parser-function costs too. Bound deadlines/queues and fail clearly rather than returning truncated statistics as complete. Discuss derived state-directory caches only if measurement warrants them; no prebuilt indexer or synchronization chain.

Compile macOS arm64/x64 separately with compiled pages/resources embedded. Cross-target compilation is not cross-architecture acceptance: test system SQLite, WAL, time zones, launchctl, and actual packages on both real architectures.

Release repository, tap, version, minimum macOS, and signing/notarization policy remain to be determined; archives include SHA-256. Verify Gatekeeper, installed PATH, background operation, and browser opening on clean machines without Bun/Node/development tools.

Constraint assessment: P-1/P-3 use native facilities/page controls; P-2 reuses four source tables read-only with no new business tables. NFR rules/convention cards informed avoidance of N+1, short transactions, explicit errors, and redacted logs. Java/PostgreSQL/Vue stack constraints do not apply; do not copy enterprise log retention or source-index requirements. Scans and OFFSET are explicit deviations whose bounds require baselines.

`codeUnderstanding.skipped`: This is greenfield document design with no product call graph to index, so no extra code index/cache is generated. Before implementation, confirm draft defaults, upstream versions, samples, and release ownership. Cache inclusion, money units, and turn attribution remain unknown.

## 9. Selection References

- Official Bun documentation: [Compiler](https://bun.com/docs/compiler), [SQLite](https://bun.com/docs/runtime/sqlite).
- Verified: stable `bun build --compile` includes the Bun runtime; compilation is not TypeScript checking; SQLite is synchronous, defaults integers to number, and requires explicit safe-integer mode; macOS uses system SQLite.
- These references support the choice, not claims of completed project compatibility or release verification.
