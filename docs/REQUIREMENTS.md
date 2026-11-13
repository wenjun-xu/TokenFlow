# TokenFlow Local Token Usage Explorer Requirements

Version: V0.1 (requirements draft)  
Date: 2026-11-02  
Based on: the user's description and [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).

## 1. Product Goal

TokenFlow is a local, read-only token usage analysis tool for GitHub Copilot CLI users. After installing through Homebrew or another command-line method, users run `tokenflow start` to open the dashboard automatically in their browser, filter sessions by year, month, or day, and open session details to inspect usage and individual requests. `tokenflow stop` shuts down the service.

Core workflow:

```text
Command-line installation → tokenflow start → Browser home → Date filters
                                                          → Session list → Session details → Back to list
                            tokenflow stop → Local service stopped
```

The initial deliverable for this draft was the requirements document; v0.1.0 used a Python source package and was publicly prereleased. The user has now selected a TypeScript + Bun standalone executable while retaining a self-managed Homebrew tap, to reduce dependency downloads and compilation during first-time installation. See [`../README.md`](../README.md) for usage and release instructions.

## 2. Scope and Draft Conventions

### 2.1 Required in the First Version

- Command-line installation and `tokenflow start` / `tokenflow stop`.
- Automatic opening of the default system browser once the local service starts.
- Year, month, and day filters at the top, usage totals, and a paginated session list.
- Session details: basic information, token totals, totals by model, model request details, and conversation turns already recorded in the database.
- Clear feedback for missing data, read failures, incompatible schemas, and service shutdown.
- Read-only access to local data throughout; no uploading of sessions or usage information.

### 2.2 Excluded from the First Version

User accounts, cloud synchronization, team sharing, cross-device aggregation, support for multiple AI tools, cost estimates, budget alerts, data editing or deletion, data export, automatic startup, real-time log parsing, and tool execution details.

The first version does not depend on `events.jsonl` or infer session activity from logs. References to `tokenboard`, log indexing, and existing APIs in the schema document describe the source context only; they are not implementations that already exist in this project or must be reused.

### 2.3 Draft Defaults

The following product rules are proposed to make implementation practical, not facts individually confirmed by the user. Any changes before implementation should also update the corresponding acceptance criteria.

| Item | Default |
|---|---|
| Initial platform | macOS, covering Apple Silicon and Intel |
| Installation channel | A self-managed Homebrew tap as the primary channel, with architecture-specific standalone executable archives and SHA-256 checksums; users need no runtime installation or compilation |
| Data source | The current OS user's local Copilot SQLite database |
| Date semantics | Filter model usage occurring during the selected period, not sessions created during that period |
| Initial date condition | All time |
| Data updates | Manual refresh on the page; automatic polling is not required |
| Service instances | One instance per current user, not a separate instance per project |
| Interface language | English; model identifiers and original field values remain unchanged |

## 3. Installation and CLI Behavior

### 3.1 Installation

After installation, users can run `tokenflow` directly in a new terminal without cloning source, installing development tools, or manually starting frontend and backend services.

Proposed Homebrew distribution:

```bash
# No prior brew tap is required; the installation source selects a precompiled executable by architecture.
brew install wenjun-xu/tap/tokenflow
```

The release channel provides versioned standalone executable archives with embedded page assets and the Bun runtime, plus SHA-256 checksums. Homebrew downloads and installs the appropriate architecture without additionally installing Python, Node.js, or Bun, and without compiling on the user's machine. An online installation script is not required. Public GitHub downloads remain subject to internal network policies; without an internal mirror, download speed on an internal network is not guaranteed.

### 3.2 Commands

| Command | Expected behavior |
|---|---|
| `tokenflow start` | Check the data source, start the local service in the background, and open the default browser after readiness is confirmed |
| `tokenflow start --db <database-path>` | Use the specified SQLite database; paths with spaces are supported |
| `tokenflow stop` | Stop the current user's TokenFlow instance and release its listening port |
| `tokenflow --help` | Display commands, arguments, and the default database location |
| `tokenflow --version` | Display the current tool version |

### 3.3 Startup

1. Read `~/.copilot/session-store.db` by default; never create an empty database automatically if the path does not exist.
2. Check file permissions, required tables, and required fields read-only. Report unsupported schemas clearly without modifying the source database.
3. Listen only on the local loopback address, let the OS allocate an available port, and print the actual access URL in the terminal.
4. Open the browser automatically after confirming the service is accessible. Closing the launching terminal must not terminate the started service.
5. Reuse a healthy existing instance and open its URL rather than starting a duplicate service.
6. If the running instance uses a different database, ask the user to stop it first; never silently switch data sources.
7. If opening the browser fails, keep the healthy service running, report the failure, and print a URL that can be opened manually.
8. On startup failure, report the cause, clean up resources created by this startup attempt, and exit nonzero; never report successful startup.

### 3.4 Shutdown

- After normal shutdown, print “TokenFlow stopped”; the service must no longer respond and the port must be released.
- If no instance is running, print “TokenFlow is not running” and treat this as idempotent success.
- If process identity is stale, safely clean up only the tool's own state; never kill another process based solely on an old PID.
- Report shutdown failures clearly and return a nonzero exit code; never claim success falsely.
- Stopping the service must not close the user's browser, stop Copilot, or delete or modify source data.
- On the next failed request, an already open page should report that the service is unavailable and suggest `tokenflow start`. Active push notification of shutdown is not required.

## 4. Data Sources and Shared Definitions

### 4.1 Tables Read in the First Version

| Table | Purpose | Relationship |
|---|---|---|
| `sessions` | Session metadata and the main session list | `id` |
| `assistant_usage_events` | Tokens, call counts, model totals, and request details | `session_id = sessions.id` |
| `turns` | User messages and assistant responses already recorded in the database | `session_id = sessions.id` |
| `schema_version` | Compatibility diagnostics | Read the actual versions; do not assume a single row |

Other business tables, full-text-search internal tables, and SQLite system tables are not displayed in the first version. Schema 8 is the known reference, not proof that all versions are compatible. Missing required structures must produce clear errors; new unused fields should not by themselves block reads.

Do not join requests and turns by session before aggregation: one-to-many joins can double-count usage. Aggregate requests independently and count each request exactly once.

### 4.2 Token Calculations

| Metric | Definition |
|---|---|
| Input tokens | Sum of `input_tokens` over the selected requests |
| Output tokens | Sum of `output_tokens` over the selected requests |
| Cache-read tokens | Sum of `cache_read_tokens` over the selected requests, displayed separately |
| Total tokens | Input tokens + output tokens |
| Model call count | Number of records in the selected request set |
| Session count | Number of distinct sessions matching the current filters |

- Do not add cache reads to total tokens or subtract them from input and claim the remainder is “new input.”
- Input includes context repeatedly carried by multiple requests. Do not deduplicate text; total tokens do not represent unique text volume.
- If any participating value is `NULL`, display that metric's total as “Unknown.” Never substitute zero or present a known partial sum as the complete total. Total tokens are also unknown when input or output is unknown.
- An empty request set has zero tokens and calls; distinguish this from requests with missing fields.
- Unknown cache reads do not affect total tokens when input and output are both known.
- Do not include `cache_write_tokens` or `reasoning_tokens` in total tokens.
- Do not convert `total_nano_aiu` or `request_multiplier` to money, credits, or other consumption metrics.
- Use thousands separators while preserving exact integers; do not hide detail behind only abbreviated `K/M` values.

### 4.3 Dates and Time Zones

- Filter using `assistant_usage_events.created_at`, not `sessions.created_at` or `updated_at`.
- Interpret dates in the service's OS local time zone and show the active time zone on the page.
- Interpret timezone-less SQLite time text as UTC and ISO timestamps with time zones as their actual instants. Do not compare timestamp prefixes directly to local dates.
- Use inclusive local starts and exclusive starts of the next period. Handle year boundaries, leap days, and daylight saving time correctly; do not assume every day lasts exactly 24 hours.
- For sessions spanning days, count only requests within the selected period. A session created yesterday with calls today must appear when filtering today, with only today's calls counted.
- All-time results include sessions without usage, with zero totals. Date-specific results include only sessions with requests in the period.
- Requests with missing or unparseable timestamps may still count toward their sessions in all-time results. Do not guess their date-specific period; report how many cannot participate in date filtering.
- Do not invent sessions for orphan requests lacking a matching `sessions` row. Report the orphan count and exclude these requests from home-page session totals to keep totals consistent with the list.

## 5. Home Dashboard

### 5.1 Layout

```text
TokenFlow                              Data source / Time zone / Refresh
Year [All]  Month [All]  Day [All]  [Query] [Reset]
Current range: All time
Sessions | Model calls | Input tokens | Output tokens | Total tokens | Cache reads
-----------------------------------------------------------------
Session summary | Project | Created | Latest request | Models | Calls | Token details
Sessions…
-----------------------------------------------------------------
N sessions total                         Previous / Current page / Next
```

### 5.2 Date Filter Interaction

- Years offer “All” and years with parseable usage records; months offer “All” or 1–12; days offer “All” or valid days in the selected month.
- Disable month and day until a year is selected; disable day until a month is selected. Changing year clears month and day; changing month clears day.
- Selecting only a year queries the full year; year and month query the full month; year, month, and day query that day. “All” queries all time.
- “Query” applies the selection and returns to page one; “Reset” restores all time and page one.
- The server must also validate dates and reject invalid conditions such as February 30.
- When filters match nothing, display an empty state and a reset action rather than pretending the read failed.

### 5.3 Totals and List

- Totals cover all matching sessions and requests, not only the current page.
- Use `summary` as the session summary; fall back to an abbreviated session ID when empty. The complete ID is available in details.
- Prefer `repository` for project identity, then `cwd`, then `Unspecified` if neither exists. A directory fallback may show the directory name; details retain the full path.
- Show creation time, latest request within the current range, actual `model` values, call count, input, output, total tokens, and cache reads.
- Clearly distinguish unknown values from zero. Show “—” for latest request when there are no requests.
- Default to descending latest request within the current range, missing values last, with session ID as a stable tiebreaker.
- Default to 20 rows per page. Previous, next, and total count suffice; no custom sorting or complex table configuration in the first version.
- Rows can open details, and each session also has a keyboard-operable link.
- Display the latest successful read time. “Refresh” queries again while preserving date filters.

## 6. Session Details

### 6.1 Navigation and Statistical Range

- Provide “Back to sessions,” preserving original date conditions and page number.
- Inherit the list's date range and explicitly label “Usage in the current period” or “All-time usage.”
- Provide “View all time for this session” and a way to restore the original range; never silently replace period totals with whole-session totals.
- If the session does not exist, show a clear message and a return action.

### 6.2 Basic Information

Show full session ID, summary, repository, working directory, branch, host type, creation time, and update time.

Show “Not recorded” for missing basic fields. Display `updated_at` as stored; do not interpret it as the last call time, current activity status, or session end time.

### 6.3 Usage Totals and Model Breakdown

- Show call count, input, output, total tokens, and cache reads using the same definitions as the home page.
- Group by `assistant_usage_events.model` and show those metrics. Each request belongs only to its actual recorded model.
- The union of model-group requests must equal the requests in the current session range. If a group has missing fields, overall metrics still follow the shared unknown-value rules; do not add only known groups.
- Do not substitute `copilot_usage_model` for the actual model when merging groups; unknown mappings could distort results.

### 6.4 Model Request Details

Each row represents one `assistant_usage_events` record. Default order is request time ascending, then ID ascending, with unparseable timestamps last; 50 rows per page.

| Display | Fields |
|---|---|
| Request ID, occurrence time, actual model | `id`, `created_at`, `model` |
| Input, output, cache reads, total tokens | The three token fields and the specified formula |
| Call duration, time to first token | `duration_ms`, `time_to_first_token_ms`, in milliseconds |
| Original turn index, agent identifier | `turn_index`, `agent_id` |
| Initiator, finish reason | `initiator`, `finish_reason` |

For unparseable timestamps, show the original value and an anomaly indicator. Show “Not recorded” for empty fields. Original `turn_index` is source data only, not verified conversation attribution. The distinction between `output_ttft_ms` and the other first-token field is unconfirmed; do not interchange them.

### 6.5 Conversation Turns

- Read existing turns from `turns`, ordered by `turn_index` ascending. Show index, time, user message, and assistant response, with 20 turns per page and long content collapsed for on-demand expansion.
- Always label this area “Recorded conversation for the entire session.” Do not filter it by request dates; make this explicit so it is not mistaken for turns corresponding to period usage.
- Render content as safe plain text and preserve line breaks; do not execute or directly render source HTML.
- Do not infer request attribution from index offsets, adjacent timestamps, or agent fields; do not show per-turn token totals.
- When empty, show “No conversation records in the database.” Do not claim that no conversation occurred or promise real-time or complete content.

## 7. Local Security, Reliability, and Errors

- Access SQLite read-only: no migrations, indexes, repairs, or source writes. Support normal Copilot writes and WAL data; do not ignore an active WAL.
- Use a consistent view for one page read so totals and lists do not contradict each other because of different read times. Do not hold read transactions long enough to affect the source application.
- Allow local access only, validate Host/Origin, and do not enable wildcard cross-origin access. Read APIs and shutdown controls must not be open to arbitrary websites.
- Load no external CDN, analytics scripts, or remote fonts. Send no telemetry, message content, paths, or usage records.
- Write process identity, port, and necessary runtime logs only to the tool's own state directory. State is readable/writable only by the current user; logs must not contain message content or sensitive request content.
- Clearly explain missing databases, permission errors, corruption, lock timeouts, or unsupported schemas and suggest remedies. Never create an empty database automatically or return a success-shaped empty result.
- Show refresh errors. If retaining previous successful data, also label it “Data is stale” and show its read time rather than treating it as current.
- Give clear feedback when a session is deleted during reads or the database changes; do not leave the whole page unresponsive.
- Filters, links, and pagination must be keyboard-operable and have readable labels. Loading, empty, unknown, and error states must not depend on color alone.
- Paginate both home and details; do not send all content to the browser merely to display totals. Determine performance targets and maximum scale from real samples during technical design rather than inventing response-time promises in this draft.

## 8. Acceptance Criteria

| ID | Scenario | Pass condition |
|---|---|---|
| AC-01 | Fresh installation | After installing the release on a supported macOS architecture, `tokenflow --version` runs without source or a development environment |
| AC-02 | Startup | With a readable compatible database, `tokenflow start` starts the service, prints the URL, and opens the home page; it remains accessible after the launching terminal exits |
| AC-03 | Repeated startup | A second start reuses the existing instance; a different data source produces a clear message without a new instance or silent switch |
| AC-04 | Browser failure | If the default browser cannot open, the terminal URL still works manually and a clear warning is shown |
| AC-05 | Year/month/day filtering | Full-year, full-month, single-day, and all-time queries return correct sessions based on local request time; invalid dates are rejected |
| AC-06 | Time boundaries | Year boundaries, leap days, UTC timestamps crossing local midnight, and DST samples fall in the correct inclusive-start/exclusive-end date intervals |
| AC-07 | Sessions spanning days | A session created yesterday with requests today appears in today's list; today's totals exclude yesterday's requests |
| AC-08 | Token formula | One request with input 100, output 20, and cache reads 80 has total tokens 120, not 200 |
| AC-09 | Unknown versus zero | If one of two requests has NULL input, input and total tokens are unknown; a session without requests has zero; unknown cache does not affect known total tokens |
| AC-10 | No duplicate totals | Multiple requests and turns in one session still produce a call count equal to the request count; pagination does not change totals over all matches |
| AC-11 | List and details | Opening a session yields consistent basic information, period totals, model groups, and requests; returning preserves filters and page |
| AC-12 | Range switching | Details can switch between all-session usage and the original period; the conversation area is always explicitly whole-session and never shows inferred per-turn tokens |
| AC-13 | Pagination and refresh | Sessions, requests, and turns follow their pagination rules; manual refresh shows newly committed records and updates read time |
| AC-14 | Data errors | No matches and read failures are distinct; permission, compatibility, and lock timeout errors do not show false zeros; anomalous times and orphan requests include counts |
| AC-15 | Local read-only access | Source schema and business data are unchanged before and after acceptance; Copilot can continue writing; the service does not listen on LAN addresses or request third-party resources |
| AC-16 | Shutdown | After `tokenflow stop`, the service is inaccessible and the port released; repeating stop succeeds idempotently; stale PIDs do not kill unrelated processes |
| AC-17 | Content and access security | Message HTML/scripts appear as text; unauthorized sites cannot read usage cross-site or trigger shutdown |
| AC-18 | Incomplete data | Missing conversations, unknown fields, empty summaries, and missing project information use specified fallbacks without inferring nonexistent session status |

## 9. Items to Resolve Before Release

- The installation source is `wenjun-xu/homebrew-tap`; prepare the project repository as `wenjun-xu/TokenFlow` and the initial version as `0.1.0`. Confirm repository name, license, and supported macOS before public release, then upload the source archive and matching formula.
- Confirm the draft defaults in Section 2.3, especially filtering by request occurrence time rather than session creation date.
- Determine compatibility, performance baselines, and read-only concurrency verification using the target Copilot CLI version and samples.
- Keep unconfirmed upstream cache inclusion, billing units, and turn attribution unknown; a requirements document is not proof of upstream semantics.
