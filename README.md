# TokenFlow

A local, read-only GitHub Copilot CLI token usage dashboard. Inspect sessions, model usage,
individual requests, and recorded conversations without uploading data or estimating costs.
The database and local `events.jsonl` files are queried read-only, on demand.

## Installation

```bash
brew install wenjun-xu/tap/tokenflow
tokenflow start
```

No prior `brew tap` is required. Starting with v0.2.0, Homebrew downloads a
**precompiled standalone executable** for your Mac's architecture, ready to run after extraction.
No Python, Node.js, Bun, npm, or database tools are required, and nothing is compiled on your machine.
The runtime and web assets are included. The v0.2.0 Apple Silicon archive is approximately 39 MiB;
this is the actual download size, not a promise of a fixed installation time.

First-time installation still downloads the Homebrew tap and release archive. Precompilation reduces
installation steps, not network restrictions. Internal networks must allow access to GitHub, its raw
files, and Release download URLs; the project currently provides no internal mirror.
If Homebrew auto-update takes too long, disable it for this installation only:

```bash
HOMEBREW_NO_AUTO_UPDATE=1 brew install wenjun-xu/tap/tokenflow
```

This does not skip integrity verification or resolve proxy timeouts. Do not disable TLS verification.

Without Homebrew, download `tokenflow-<version>-darwin-arm64.tar.gz` (Apple Silicon) or
`tokenflow-<version>-darwin-x64.tar.gz` (Intel) from
[Releases](https://github.com/wenjun-xu/TokenFlow/releases), verify `SHA256SUMS`,
extract it, and run `./tokenflow start`. Keep the executable: the background service and query
subprocesses need it. If macOS refuses to open the download, verify its source and follow the
system instructions rather than disabling Gatekeeper.

To upgrade an existing installation to v0.2.3:

```bash
tokenflow stop
brew update
brew upgrade wenjun-xu/tap/tokenflow
tokenflow --version
tokenflow start
```

## Usage

The home page uses a light-gray background, compact overview, and approximately 38% / 62% split: actual usage trends and a Top 5 share pie chart on the left, and a ten-column session table on the right. On narrow screens, trend, share, and details stack in that order; the table scrolls horizontally on its own. “Today / Last 7 days / Last 30 days” synchronizes all statistics using the service's local time zone, with hourly buckets today and daily buckets for recent periods; missing metrics remain gaps. The details table has no search, filter, sortable-header, or export controls, retaining view actions, page size, and pagination. This layout supersedes the older home filter bar, doughnut chart, four cards, and empty-state description; read-only sources and detail features remain unchanged. Later usage notes below describe subsequent layout and chart refinements.

```bash
tokenflow start
tokenflow start --db "/path with spaces/session-store.db"
tokenflow start --no-browser
tokenflow stop
tokenflow --help
tokenflow --version
```

The default database is `~/.copilot/session-store.db`. Startup opens a browser or prints a URL
you can open manually. The URL contains a temporary access credential: do not share it.
Closing the terminal does not stop the service; repeated starts reuse the current user's instance.
Stop the existing instance before switching databases.

The home page offers “Today,” “Last 7 days,” and “Custom,” defaulting to today. Today uses the OS local time zone captured when the service starts, not the browser's date. “Custom” opens a native modal dialog with a single row of native year, month, and day dropdowns, no longer separate start/end rows. Month and day both offer “All”: all months selects the whole year and fixes day to All; a selected month with all days selects the whole month; specifying all three selects one day. Months and days update together, correctly handling month lengths and leap years and excluding future dates. “Apply” closes the dialog and updates data; “Cancel,” “Close,” or Esc dismisses it without changing the applied range and returns focus to “Custom.” Invalid dates have explicit in-dialog messages. Date changes fetch and update data without reloading the page; old data stays visible while loading. Success updates the URL and resets to page one, preserving repository, model, sort order, and page size. Rapid changes cancel old requests and apply only the latest result; failures retain old data and the applied range with a clear error. Date controls are not rebuilt; automatic refresh pauses while the dialog is open, preserving uncommitted edits and “All” selections. Pagination and returns from details preserve the applied range. Restart after changing the system time zone; existing date-range and last-30-days URL/API parameters remain compatible. Home-page session summaries use the same 12px font size as other table content.
All page timestamps use system local time in `YYYY-MM-DD HH:mm:ss` format; original database values remain unchanged.
Turn lists paginate by original numeric turn index descending, while turn trends retain numeric ascending order. Individual-turn requests and whole-session records in dialogs paginate by time descending.
Sorting preserves original fractional-second precision, placing invalid timestamps last.
Home defaults to latest-call time descending. Headers show column names only, without sort buttons or triangles; existing URL and API sort parameters remain compatible.
Sorting is computed over every matching session before pagination. Unknown total tokens and missing valid request times remain last in their respective sorts, in either direction. Equal totals use latest-call time descending then session ID for stable ordering; equal request times use session ID.
Changing date, repository, model, or sort resets to page one. Reset restores today and clears repository/model filters while retaining applied sorting. Pagination, details-and-back navigation, and automatic home updates also preserve filters and sorting.
Home and detail lists begin with sequence numbers; paginated lists number continuously across pages, independently of original request IDs.
The home session table shows session summary, project, total tokens, call count, actual models, latest request in range, and view action in that order. Session ID, input, and output columns are removed without changing totals, sorting, filtering, or detail data.
Column widths are allocated explicitly: summaries take remaining space, while project, time, model, and numeric columns stay stable. Time and numbers stay on one line; numbers align right and total tokens are bold cyan.
Overflowing summaries, projects, and model names use ellipses with complete hover text; underlying text and exact numbers are not truncated. The minimum table width is 1080px, avoiding horizontal scrolling at typical desktop widths. Narrow windows scroll only within the list; expanded metadata may wrap without forcing times or token counts onto multiple lines.
List height is capped at 32rem or 65% of the viewport; excess rows scroll internally beneath a sticky header. Tab can focus the list for arrow-key scrolling.
Home, detail pages, and dialogs use a restrained data-console style: near-black base, layered panels, cyan key values and query buttons, and local monospace fonts for numbers and tool content. No remote fonts, decorative animations, or glows. System light mode, visible keyboard focus, and subtle hover feedback are retained. Total tokens are emphasized first on home and session overviews by metric identity, not card position. Dialog height is capped at 30rem or 65% of the viewport, with internal overflow scrolling.
Total tokens equal input plus output; cache reads are displayed separately. Missing metrics show unknown; empty sets show zero.
Request duration and time to first token are displayed as recorded in milliseconds, allowing fractions without integer truncation; token counts and turn indices still require integers.
Session details combine calls with the same original turn index into one row showing call count, aggregate tokens, first/last call time, and models.
Aggregate all calls in the current date range before pagination, at 10 turns per page; do not merge only requests on one page.
Neither whole turn rows nor turn names navigate on click. Only the “Call details” action opens that turn's call-list dialog on the current page, at 10 calls per page. “View” switches within that same dialog to one call's model output and tools, without stacking a second dialog or substituting the whole conversation.
Returning to turns preserves the date and turn page; returning to sessions preserves the original filters.
Session overviews show three token lines—input, output, cache reads—with turns on the horizontal axis and aggregated per-turn usage vertically. Call details show only the individual-call list, without a repeated line chart.
Overview charts cover every recorded-index turn in the current range, independently of list pagination. Hover or Tab focus reveals that turn's conversation, and accessible point labels retain exact values.
NULL remains a gap, not zero. Calls with anomalous timestamps appear last as separate points with an explicit unknown-order message.
Charts use embedded SVG, with no chart dependency or external resources. Large integers are scaled only for pixels; tooltip values remain exact.
Index 0 remains turn 0; NULL appears separately as “Turn not recorded,” without guessed attribution. Grouping uses original database indices and does not prove official conversation associations.
Turn token totals sum call usage without deduplicating repeated input context; missing metrics show unknown.
Invalid timestamps do not contribute to first/last valid call times, but their calls still count in all-time statistics.
Home automatically updates every 15 seconds, pausing in the background and during interaction; turn overviews and single-turn pages do not poll.
Details, date filters, pagination, and returns preserve state through home navigation query parameters. JS/CSS assets still reject query parameters,
and every data API still requires the temporary access credential.
Single-turn call details switch to individual details only through “View,” operable with Tab and Enter/Space; original model-request lists still support whole-row click or keyboard opening. Esc or clicking outside dismisses dialogs, and the turn-call dialog also has “Close.”
Individual details do not repeat request metrics already in the list. Expand model output, tool parameters, results, and execution status as needed. “Back to call list” preserves page, loaded summaries, and scroll position; standalone detail dialogs opened from original request rows still have no buttons.
Each turn's content in whole-session records, and input, output, and tool details in individual dialogs, are collapsed by default and expand by clicking headings; errors remain visible.
Tool headings include short argument summaries, such as the loaded skill, viewed file and lines, search identifier, or command type.
Summaries do not invent explanations. Long text is abbreviated; commands show only known command names and fixed subcommands, not arbitrary arguments, environment variables, headers, or URL credentials.
Multiple model requests in one conversation turn display their own content separately; tool instructions without a textual reply are normal output.
Tool names, arguments, results, and status come from `session-state/<session-id>/events.jsonl` beside the database.
The database has no `apiCallId` foreign key. Association requires the same session, agent, timestamp second, model, and input/output/cache/duration/finish-reason metrics
to be unique in both database and log; then log `apiCallId` identifies model output and `toolCallId` identifies the corresponding execution.
Do not guess using turn indices, nearest time, or record order. Cross-second matches, missing metrics, multiple candidates, or missing logs produce explicit messages, never a fallback to whole-turn content.
Individual details do not require an existing `turns` row, so delayed conversation writes do not hide already logged call output.
Input is shown only when a log explicitly associated by call ID contains complete input; otherwise it is marked not recorded. Original user messages are not presented as complete model input.
Expanded tool arguments and results are shown in full. Results not yet returned are pending recording; failures are marked failed, without invented success results.
Logs are read only in the existing file-write-isolated process. Symlinks and files not owned by the current user are rejected; each scan is capped at 128 MiB and only complete JSONL records are displayed.
“Whole-session records” opens all recorded conversation in a dialog independently of date filters; sessions without model requests retain this entry point.
Whole-session records come from `turns` and may lag live logs. Tools use an explicit `interactionId` located by the user message, not an individual model call. When the original message and runtime-added `steering` messages share an interaction, shared main-session tools may be shown with a clear warning that they were not necessarily triggered only by this message; the assistant reply from a steering message's turn is not borrowed. Identical user messages in different interactions remain ambiguous. Tools deduplicate by `toolCallId`: identical repeats count once, conflicting records refuse association. Tool starts retain the explicit model-turn/interaction association present at that time, preventing reused `turnId` values during session restoration from mixing incomplete tools from another interaction.
Turn lists preload only user-message summaries of up to 240 characters, not full conversations or tools. Full content loads through an isolated read-only query on first chart-point hover or detail opening. The turn API is
`/api/sessions/<session-id>/rounds`; `roundPage` paginates turns,
and `round=<original-index>` or `round=missing`, with `requestPage`, selects a turn's call list. The new individual-call API is
`/api/sessions/<session-id>/requests/<request-id>/call`, with no query parameters; existing APIs retain 400-character previews and `full=1`.
Each turn occupies a fixed 64px chart slot, with its point centered: one turn takes one slot, two take two, without stretching to fill available width. The module remains full-width. Background grids fill the available plotting area and align with left-axis ticks without scrolling with data. When necessary, data scrolls horizontally while the left token axis stays fixed.
Home now places “Today / Last 7 days / Custom” plus total, input, and output statistics at the top. Usage trend and an all-session usage bar chart appear on the left, with independently scrollable session details on the right. The bar chart replaces the Top 5 pie, no longer limiting results to five sessions. Modules stack on narrow screens while the bar chart remains horizontally scrollable. No matching sessions produces an explicit empty state; nonzero diagnostics and read errors remain visible.
Repositories match the complete recorded `repository` exactly; models match actual call `model` exactly, without inferred families. Combined with dates, both constrain lists, totals, trends, and all-session bars. Model filters sum only matching calls' tokens, cache, counts, and latest request time, not other-model usage in those sessions. The API retains sorted, deduplicated repository and actual-model options within the range. Changing time returns to page one while preserving repository, model, and sorting parameters; pagination and returns home preserve filters. In session details, repository/model are saved only as return state; details show all models for that session within the date range.
The session usage bar chart shows every session matching current date, repository, and model filters, in the same sort order as the right-hand list, not independently re-ranked by usage. It includes all results regardless of list page or page size. Each session occupies 48px: a 34px bar plus 14px spacing, with horizontal overflow only. The left token axis and five tick levels stay fixed; grid and bars share one scale. Session summaries are angled along the horizontal axis, long summaries abbreviated, with no token labels on bars. Full summary, session ID, project, and exact usage remain in native hover text and accessible labels. Clicking a bar or angled summary, or pressing Enter, opens details while preserving date and home-filter return state. Zero and unknown totals remain represented; unknown is labeled “Unknown,” not replaced with zero, and negative bars extend below the zero baseline. Heights use exact integer calculations with a 1px marker for tiny nonzero values. Axis ticks use compact units or scientific notation for huge numbers; hover values remain exact. Native SVG and external CSS add no dependencies. `/api/dashboard` returns `session_usage` in the same snapshot, including all matching session IDs, summaries, projects, and in-range usage. Original Top 5 API fields remain for existing clients but are no longer used on home.
On the first home load without an explicit range, `/api/dashboard?date=today` reads the service's local today. Success writes year/month/day to the URL and synchronizes list, totals, trend, and bars to that day without first showing all-time data. The API supports hierarchical `year`, `month`, `day`, `start/end` date ranges, and undated all-time queries, plus mutually exclusive `date=today|last7|last30`. It returns service-local `today` and rejects future year/month/day ranges. Existing `year=` all-time URLs remain compatible. Statistics use the OS local time zone captured at service startup; restart after changing it.
While visible, home reads the applied range, repository, model, sort, and pagination every 15 seconds without reloading the document or adding browser history. Totals, trend, all-session bars, and list update together while preserving unsubmitted date choices, bar-chart horizontal position, list scroll, and page position. Updates pause when the date dialog is open, controls or lists have keyboard focus, or text is being selected. Polling pauses in the background and attempts an immediate update on return. Failures retain old data, show staleness and the latest successful read time, and retry later. Turn overviews and single-turn pages do not auto-refresh. Normal zero diagnostics and read status consume no visual space; nonzero diagnostics and errors remain explicit.
Turn overviews use a separate compact layout: a top-left summary, then one metadata/usage module combining working directory, session ID, and four metrics ordered total, input, output, cache reads. Model call count is no longer repeated at the top, but remains in lists. Metadata and statistics share spacing and labels; total tokens use a slightly larger cyan monospace value while other values stay compact. No back text or creation/update times. Copy buttons are removed from summary and metadata; long fields use ellipses with full hover text. With normal desktop data, summary plus metadata/usage occupy about 120px and the full turn chart about 260px. Turn and single-turn call lists default to 24rem, capped at 50% of the viewport and shrinking further when desktop space is tight. Sticky headers and internal vertical scrolling prevent loaded rows from lengthening the page. Fields and statistics wrap on narrow screens while lists keep independent scrolling. Home uses the same four-metric order.
The overview API's `round_trend` includes every turn within the date range, sorted by exact numeric turn index ascending. Lists sort descending at no more than 10 turns per page: newest first, turn 0 last among recorded turns. Columns are turn, call count, total tokens, models, conversation summary, and actions. Conversation summary precedes actions, takes one line with ellipses, and retains the full preview on hover; single-turn operation summaries retain their existing two-line style. A turn summary requires exactly one `turns` row for the same session and actual turn. Missing or duplicate records have explicit messages, without guessed offsets. Each point represents that turn's aggregate input, output, and cache reads, with actual turn indices on the horizontal axis. Requests missing indices remain only in totals and at the end of lists; no inferred curve position or fabricated missing turns. Known-index turns with anomalous time still sort by index and appear as separate points. The vertical axis stays fixed; the full horizontal axis scrolls, and the top-right legend matches the single-turn page.
Home usage trends show input (cyan solid), output (blue dashed), and cache reads (purple dotted), with matching legend colors and line styles. A blue gradient fills below input so fill remains visible when output is near zero. There is no token-type filter; hover shows only time and the three exact metrics, not sessions or session links, and closes immediately when leaving a point. Detail turn charts likewise use cyan input, blue output, purple cache reads, and blue input-area fill visible even when output is zero. Missing or anomalous data remains disconnected. Charts allow native horizontal scrolling only, not internal vertical scrolling. More data expands plot width; touch and left/right keyboard scrolling are supported, every point is retained, and scrolling hides tooltips anchored to old positions.
Turn-chart hover cards show the turn's conversation directly, without a “View turn details” button or splitting it into individual model calls. Cards show turn, call count, deduplicated model names, and user/assistant previews collapsed by default; headings expand full content, with explicit messages for unrecorded replies. Only first hover queries the unique same-turn conversation via `round_trend.request_id`; this identifier is query-only and is not displayed as an individual call. Missing/duplicate conversations are explicit. Main-session tools are collapsed; first deliberate expansion reads every tool page, showing each execution's name, operation summary, expandable full arguments/results, and failed/pending/unknown status. Shared interactions are marked, and subagent internal calls are excluded. Cards appear only over turn dots. Leaving a dot starts a 250ms close delay, allowing crossing the gap into the card to read, scroll, or expand. Leaving both dot and card closes it even if the pointer remains in blank chart space. Entering another turn dot shows its content. The same hover and asynchronous loading preserve position and expansion state; switching turns or reopening after closing resets all content to collapsed, reusing page-cached content/tools but not expansion state. Tab focus shows the card; Enter/Space moves inside for scrolling, expansion, and text selection; Esc closes. With date filters, call counts/models use the current range, while conversation/tools are not date-clipped and shared-interaction scope is explained separately. Only “Call details” in the lower turn list opens the call-list dialog.
Turn overviews and single-turn call pages remove bottom “Previous/Next” controls. Manually reaching a scroll edge loads adjacent pages on demand, at most 10 records per load, supporting wheel, touch, scrollbar dragging, and keyboard. Downward loads append older records; upward loads prepend newer records. Loaded pages stay in the same list; prepending compensates height to preserve the original row position, without rebuilding lists, top totals, or charts. Horizontal scrolling never triggers pagination. Only one page loads at a time; failure retains all rows and shows Retry. Success replaces the list page in the current URL, preserving dates and return state without new history; call-list dialogs retain their original pagination. Whole-session records and restore-range actions sit beside the turn-list heading, not in top metadata. Return to sessions uses browser Back. Original model-request APIs remain at 50 per page; only turn overviews and single-turn call lists use 10.
The call-list dialog is lightweight: turn title, “Close,” in-range call count, and whole-turn total tokens at the top, without a chart, whole-turn conversation panel, or usage cards. Date-filtered titles retain the statistical range; the default “All time” label is omitted. Totals include every call in that turn and date range, not only the page. Width is capped at 72rem and stays within narrow viewports; the table scrolls independently in both directions. Opening, switching, and closing do not change the page URL/history or rebuild underlying charts/lists, preserving filters, page, and scroll. Closing returns focus to the trigger.
The page reads safe summaries for the whole turn once through `/api/sessions/<session-id>/rounds/activities?round=<original-index>`, supporting the same date filters and independent of chart loading. Summaries appear in corresponding call rows. Successful tools do not repeat “Success”; failed, pending, and unknown states remain explicit. Read failures preserve lists/token values and show an error plus “Reload summaries”; no tools, unlinked calls, and missing requests each have distinct messages.
Tool summaries do not return full arguments, content, or results. Loading, confirmed no tools, association failures, and read failures have distinct messages.
Hover information stays near the pointer, preferably centered above it, flipping below or beside when needed and staying within the screen. Keyboard focus anchors to the actual curve point, not the bottom of a whole-column hit area. Position remains stable within one hover to allow entering links and expandable items.
Single-turn lists show sequence number, model, input, output, cache reads, total tokens, operation summary, and “View,” not ID, time, duration, or first-token latency. Calls stay newest-first; numbering descends from the filtered total to 1 across pages. Each page contains at most 10 calls without changing original model-request API page sizes. Only “View” switches to individual details in the same dialog; rows no longer open on click. Input, model output, tool parameters, and results start collapsed; missing complete input is explicit, not replaced with a user message. “Back to call list” reuses loaded pages/summaries without rereading and restores focus to the original “View.” Previous/Next buttons update only list and pagination, not the page URL, retaining title and totals. Timeouts/read failures are clear and retryable while old page data remains. Later pagination cancels unfinished requests so stale responses cannot overwrite newer pages; returning cancels detail loading; closing cancels list, pagination, summaries, and detail requests. Summaries preview at most three operation types; other operations are available in details. Loading, read failure, and association failure remain distinct. Original IDs are internal exact call anchors; never infer using model names or displayed numbers. List height is the smaller of 24rem and 40% of the viewport, without shrinking on a short last page. Headers stay fixed and only content scrolls; pagination appears only for multiple pages. Loading remains available to assistive technology, and nonzero anomalies are explicit. Whole-session records remain accessible from the overview.
Direct URLs with `round=<index>` or `round=missing` remain compatible with lightweight call-list pages, preserving `replaceState` pagination and native modified clicks; overview “Call details” no longer navigates there.
These are actions initiated by this model output, not per-tool token allocation. Tool results generally enter subsequent calls' input.
Most logs do not contain complete model input, so exact token consumption by a skill or tool cannot be inferred. Cache reads are separate, neither added again nor subtracted as savings.

Before upgrading, uninstalling, or migrating from v0.1.0 Python, stop the background service:

```bash
tokenflow stop
brew upgrade wenjun-xu/tap/tokenflow
# Or brew uninstall tokenflow
```

State and security diagnostics are written only to `~/Library/Application Support/TokenFlow/`,
with directory mode 0700 and file mode 0600, never to Copilot's data directory.

## Support and Security Boundaries

- macOS 14 or later, with Apple Silicon and Intel packages. Apple Silicon and the x64 standalone
  executable under Rosetta have been checked locally with synthetic data; native Intel Macs and
  other macOS versions still await acceptance. x64 isolated queries disable JIT to avoid Rosetta
  compatibility problems with file-write isolation, without weakening read-only protection.
  Large-data performance requires separate measurement.
- v0.2.0 is the standalone-executable migration prerelease; old v0.1.0 source packages and tags remain.
- v0.2.1 fixes startup failures when duration fields such as first-token latency contain fractions; it remains a prerelease.
- v0.2.2 adds individual-call/tool details, full turn line charts, compact layouts, and automatic home updates; it remains a prerelease.
- v0.2.3 provides an English interface and documentation, refined date filtering, all-session usage bars ordered like the session list, and bounded scrollable detail lists with visible blue chart gradients; it remains a prerelease.
- Copilot Schema 8 is the reference; compatibility is checked against actual required tables and fields. No source repair or migration operations are performed.
- SQLite queries run in a subprocess where `/usr/bin/sandbox-exec` prohibits file writes.
  This OS interface is deprecated. If unavailable or its isolation probe fails, reads are explicitly
  refused, with no unsafe fallback.
- Active WAL data is not ignored and source WAL/SHM files are not created or rebuilt; failed read-only access produces a clear error.
- HTTP binds only to `127.0.0.1`, validating the access key, Host, Origin, and cross-site requests.
  No HTTP shutdown API, external CDN, or telemetry. Isolation from malicious programs running
  as the same OS user is not guaranteed.
- No unmeasured installation-speed, other-macOS compatibility, or maximum-scale promises.
- Source is public, but a license has not yet been selected. A public repository does not imply permission for unrestricted use or redistribution.

## Local Development

Development and builds require Bun 1.4.4. Only developers install tooling and type-check dependencies;
users need none:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build:web
bun test tests-ts tests-release
bun src/cli.ts start --db "/path/to/synthetic.db"
bun src/cli.ts stop
```

Tests use only synthetic databases and independent state directories, never real Copilot sessions.
Isolation, native executable, and background lifecycle checks require macOS.

## Releases

Build on macOS from the source commit being released:

```bash
bun scripts/prepare_release.ts
# Optionally use an already downloaded official Intel Bun executable with a matching version:
bun scripts/prepare_release.ts dist "/path/to/intel/bun"
# After extraction, verify the actual release executable (read-only synthetic database, isolated HOME):
bun scripts/verify_native.ts "/path/to/extracted/tokenflow"
```

The script generates single-executable archives for both architectures, `SHA256SUMS`, size records,
and `dist/homebrew-tap/Formula/tokenflow.rb`; it does not upload automatically:

1. Run type checks, synthetic tests, and standalone-executable acceptance. Check signatures, startup, filtering, and shutdown on supported platforms.
2. Commit source to `wenjun-xu/TokenFlow` and upload both executable archives and checksums to a new version's Release.
   Bind the tag to the actual source commit; do not overwrite published versions.
3. Update the formula in `wenjun-xu/homebrew-tap` with URLs and SHA-256 values exactly matching the uploaded archives.
4. Verify `brew install wenjun-xu/tap/tokenflow` and `brew test wenjun-xu/tap/tokenflow`.

Archives contain only the `tokenflow` executable. Do not upload tokens, databases, state, logs,
`.publish`, `.joycode`, development dependencies, or personal configuration.
GitHub-generated source archives are not user installation packages.
