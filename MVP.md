# TokenFlow Product Goals and MVP

Date: 2026-11-11  
Status: Product recommendations based on the current project; this does not mean proposed features are implemented.  
Default positioning: First deliver local GitHub Copilot CLI token detail analysis for individual developers, then consider other tools and team scenarios.

## 1. What Problem Should This Tool Solve?

**Help users see where tokens go and trace a high-usage call back to what was happening at the time.**

The goal is not “a pretty usage chart,” but answers to four questions:

1. **How much did I use?** Input, output, and cache-read tokens today, this month, or for a particular project.
2. **Where did the usage go?** Which projects, sessions, models, turns, and individual calls account for the most.
3. **What was happening then?** The task, model output, tool actions, or skill operations associated with a high-usage call.
4. **Did an adjustment help?** Whether changing models, task decomposition, or context strategy produces a difference under consistent measurement rules.

“How much” and “where” depend on usage records; “what was happening” depends on verifiable content associations. The tool can provide evidence, but a curve alone cannot prove the cause of usage, and token counts are not actual bills.

### Target Users and Main Scenarios

| User | Scenario | Desired result |
|---|---|---|
| Developer using Copilot CLI daily | Check today's usage before finishing work | Identify today's high-usage projects and sessions |
| Developer using agents, skills, and toolchains | A task turn suddenly generates many calls | Locate individual calls and inspect associated output and actions |
| Developer managing context size | Input keeps growing in a long session | Observe call trends to help decide whether to start a new session |
| Developer choosing between models | Compare usage for similar tasks | View records by actual model without reducing differences between tasks to model quality |

These are user scenarios to validate, not conclusions from completed market research.

### Success Criteria

Users can complete this loop:

```text
Start → Select a date range → Find a high-usage session
      → Find a high-usage turn → Locate a specific call → Inspect associated output and tool actions
```

Product validation should focus on whether users can independently locate high usage, reconcile totals, and trust association evidence—not on maximizing chart count, page count, or “intelligent analysis” copy.

## 2. Current Project Status

The project already has most of a detailed-usage MVP; it does not need a rewrite.

| Capability | Current status | Product assessment |
|---|---|---|
| Local startup, shutdown, version query | CLI and precompiled executable exist | Retain; ordinary users should not need to install Bun |
| Date filters, four token totals, session list | Available | Answers basic usage questions |
| Session → turn → individual call | Turn aggregation, pagination, and details exist | The core tracing path is established |
| Trend charts | Turn trends and single-turn call trends exist | Useful for spotting changes, not equivalent to cause diagnosis |
| Model analysis | Session lists show models; session queries provide model-group data | A visible model-summary entry point is still needed, not just an API |
| Tool and skill details | Local logs are read on demand with unique association checks | Valuable, but failed associations must be explicit |
| Automatic updates and partial pagination | Home updates every 15 seconds; detail pagination updates locally | Retain to avoid interrupting detail reading |
| Project analysis | Repository or working directory is displayed | Displaying projects is not the same as aggregating, filtering, or ranking them |
| High-usage discovery | Current source supports ascending/descending session sorting by total tokens and latest call | Direct high-usage entry points for turns and calls are still missing; released 0.2.2 executables do not automatically include source changes |
| Export and costs | Not currently provided | Not prerequisites for this MVP round |

**Home-page high-usage sorting is now covered. Next, prioritize finding important records quickly: high-usage turn/call entry points, project filters, and model summaries.**

Version messaging must also be clear: `tokenflow --version` reports the executable currently on PATH, not the source in the current directory. The installed package, source, and running background instance may differ; stop the old instance before upgrading.

## 3. MVP Feature Scope

P0 means required to complete the product loop, not that every capability must be developed again; reuse existing capabilities.

### 3.1 P0: Required

| ID | Feature | Minimum implementation | User value |
|---|---|---|---|
| F-01 | Local data access and runtime status | Read the Copilot database by default; allow an existing custom database; startup, shutdown, version, and errors | No account, upload, or Copilot configuration changes |
| F-02 | Usage overview | Existing year/month/day filters; input, output, cache reads, total tokens, and read time | Show how much the selected range used |
| F-03 | Project filtering | Filter by repository identity; group by full working directory when no repository exists; separate unknown projects | Find project usage without merging same-named directories |
| F-04 | High-usage discovery | Session sorting by latest call/total tokens; detail entry points for high-usage turns and calls | Avoid paging through everything or guessing peaks visually |
| F-05 | Model summary | Aggregate call count and all four token metrics by actual model in the current range; separate unknown models | Understand model distribution rather than seeing only model names |
| F-06 | Layered details | Consistent range across sessions, turns, and calls; pagination without restricting totals or full trends | Trace totals to individual calls |
| F-07 | Call evidence | On-demand uniquely associated model output, tool/skill summaries, parameters, results, and status | Understand what happened during high usage |
| F-08 | Local privacy and reliability | Read-only database/logs, local-only access, access credentials, explicit anomalies, keyboard operation | Inspect details without damaging data or leaking content |

Minimum F-04 interaction: place a triangle icon to the right of the “Latest request in range” and “Total tokens” session-table headers; down means descending, up means ascending. Clicking the active column toggles direction; switching columns starts descending; highlight the active column. Add no top-level sorting control. Turns and calls get high-usage entry points while retaining their time trends. Unknown totals remain last in either direction and are clearly marked rather than pretending to be below known values.

F-05 needs only one table, not a dedicated model page, pie chart, or “recommended model” algorithm.

### 3.2 P1: Add After Validating Core Needs

| Feature | When worthwhile | Minimum scope and boundaries |
|---|---|---|
| Project ranking | Users need to compare multiple projects at once | Aggregate projects within the current range; clicking follows the same filtering path |
| Custom periods and before/after comparison | Year/month/day filters do not support task reviews adequately | Select start/end dates and show differences using consistent definitions; no misleading percentages when the baseline is zero or unknown |
| CSV/JSON export | Users genuinely need archives, reconciliation, or external analysis | Export current filtered metrics and definitions; exclude conversations, tool content, and full paths by default; prevent CSV formula injection |
| High-usage hints | Users want to find important records with less paging | Rank known token totals first, without a fixed default “anomaly” threshold; label as usage hints, not root causes |
| Agent summary | Users need to distinguish the main session from subagents | Use verifiable agent associations; display unidentified records separately without double-counting |
| Latency and finish-reason analysis | Users also care about slow or failed calls | Show recorded duration, first-token latency, and finish reason; do not infer missing fields |
| Diagnostics and version status | Installation, upgrades, or data compatibility cause frequent issues | Show runtime version, source, and compatibility diagnostics without reading or exposing credentials |

### 3.3 Outside This MVP

Multiple-tool adapters, cross-device synchronization, team accounts and permissions, cloud services, automatic prompt rewriting, automatic model switching, complex alerting platforms, session editing/deletion, billing settlement, and exact per-tool token attribution.

Consider cost estimation only after provider billing rules, model prices, effective dates, currency, cache semantics, and plan relationships are confirmed. Even then, distinguish estimated cost from official charges. Do not directly convert token counts, multipliers, or unconfirmed units into Copilot bills.

## 4. Pages and Workflow

Do not introduce a new frontend framework; reuse current pages, tables, SVG charts, and detail dialogs.

| Page | Responsibilities | Not its responsibility |
|---|---|---|
| Home | Date/project filters, four usage metrics, model summary, session list, and high-usage sorting | Loading every log, conversation, and tool result by default |
| Session overview | Current-session usage, full turn trend, turn list, high-usage turn entry point | Guessing official conversation attribution or mixing other sessions |
| Single-turn page | Full-turn call trend, call list, recorded conversation, high-usage call entry point | Interrupting reading with auto-refresh or treating tool counts as tokens |
| Individual-call dialog | Request metrics and trustworthy content associations; explicit not-recorded, unlinked, failed, and pending states | Presenting whole-turn content as complete model input or individual-call output |

After adding home-page filters or sorting, top totals, model groups, lists, and detail ranges must remain consistent; returning preserves conditions and page.

## 5. Data Definitions: Trust Matters More Than Feature Count

### 5.1 Statistical Units

- **Call**: One actual usage record, the smallest statistical unit; one user question may generate many calls.
- **Turn**: A group using the original turn index recorded by the data source, without guessed offsets; missing indices remain separate.
- **Session**: Identified by session ID; not interchangeable with one call.
- **Project**: Prefer the original repository identifier; otherwise group by full working directory. Directory basenames are display-only. Do not automatically merge repository address formats or multiple working copies yet.
- **Model**: Use the actual model identifier in the call record; do not independently map it to a billing model.

### 5.2 Token Calculations

Continue the current Copilot data-source definitions:

```text
Total tokens = Input tokens + Output tokens
Cache-read tokens = Displayed separately; neither added again nor subtracted as “savings”
```

For input 100, output 20, and cache reads 80, total tokens are 120—not 200 or 40.

When fields are missing, their complete totals are “Unknown”; an empty set is zero. Unknown input or output makes total tokens unknown; unknown cache does not affect known input plus output. Count repeated context in every actual request without text deduplication.

Charts may scale pixels, but details retain exact integers. Durations may be fractional milliseconds. Show percentages only when numerator and denominator are known and the denominator is positive. Reconfirm semantics for future providers rather than copying the current formula.

### 5.3 Time, Range, and Associations

- Interpret dates by call occurrence, not session creation; retain OS local time and inclusive-start/exclusive-end intervals.
- Totals cover all matching records, not the current page; joining conversations or tools must not count a call twice.
- Project-filtered totals and lists use the same project set. Do not silently omit orphan requests or anomalous timestamps; report counts and inclusion rules.
- Project, model, session, and turn totals derive from the same request set with the same missing-value rules.
- Show individual-call evidence only when the existing unique database/log association conditions hold; clearly report multiple candidates, missing logs, and incomplete records.
- A tool action coinciding with high token usage establishes association, not proof that “this tool consumed these tokens.” Tool results may enter later requests.
- Show “Not recorded” when complete model input was not saved; do not substitute the user message. Clearly distinguish whole-session records from calls in the current period.

## 6. Acceptance Criteria

These are proposed acceptance checks. Use synthetic data during development rather than reading real personal sessions.

| ID | Features | Pass condition |
|---|---|---|
| AC-01 | F-01 | The release queries version and starts without Bun; missing databases fail without creating empty files; shutdown does not kill unrelated processes |
| AC-02 | F-02, F-06 | Input 100, output 20, cache 80 yields total 120; multiple turns/tools do not increase call counts |
| AC-03 | F-02, F-05 | NULL displays unknown; empty sets display zero; model groups and overall totals follow the same missing-value rules |
| AC-04 | F-02, F-06 | A session created yesterday with calls today appears today; today's totals exclude yesterday's calls; local-time boundaries are respected |
| AC-05 | F-03 | Same-named directories under different full paths are not merged; unknown projects are separate; project filters update usage, models, and sessions together |
| AC-06 | F-04 | Known totals 120, 300, 200 sort as 300, 200, 120; ties are stable and unknowns last; pagination does not change totals |
| AC-07 | F-05 | Each call belongs to exactly one actual-model group; group call counts sum to the current range's call count |
| AC-08 | F-06 | A one-page call list still shows the full current-range trend; details, partial pagination, and return preserve filters and reading state |
| AC-09 | F-07 | Unique associations show the correct output/tools; ambiguity or missing logs never return another call's content; missing complete input is not replaced with a user message |
| AC-10 | F-02, F-08 | Home updates every 15 seconds while visible and idle; failures retain old data and mark it stale; details do not auto-refresh; background updates pause |
| AC-11 | F-08 | The source database/logs remain unchanged; only loopback is bound; unauthorized requests are rejected; no external resources or telemetry requests |
| AC-12 | F-08 | HTML/scripts do not execute; filters, pagination, chart points, and dialogs have keyboard paths; unknown/failed/pending states do not rely on color alone |

Suggested usability trial: have target users find a particular day's highest-usage session from the home page, then locate a high-usage call without developer guidance. Record time, mistakes, and understanding of cache and unknown values. Set concrete time targets after trials, without claiming existing performance results.

## 7. Suggested Implementation Order

1. **Stabilize trustworthy definitions and the existing loop.** Retain current features, clarify missing data, date ranges, and individual-call association messages; reconcile old requirements with the current README.
2. **Make important records easy to find.** Prioritize project filters, high-usage session sorting, and visible model summaries; reuse existing details without extra navigation layers.
3. **Validate before expanding.** Observe whether users still need project rankings, exports, or before/after comparisons; add P1 items individually when justified.

Do not prebuild generic adapters, plugin systems, cloud indexes, or rule engines for this plan. One source, one local user, and existing pages suffice to validate the goal.

## 8. Risks, Assumptions, and Later Decisions

- This document assumes an individual Copilot CLI product first. Other tools, platforms, or teams are undecided and do not affect these recommendations.
- The original draft excluded logs and tool details, while current 0.2.2 includes them. This analysis follows the current README and implementation rather than treating the old draft as the current feature list.
- Current support is macOS 14+. Native Intel, other systems, and large-data performance cannot be promised based on cross-compilation or local results alone.
- Log association is limited by the source. Measure actual association coverage; do not promise complete input and tool results for every call.
- Start project grouping with original repositories/full paths, without automatic identity normalization. Handle multi-format repository fragmentation later if real feedback warrants it.
- Lower token use does not mean better task completion. Evaluating efficiency later requires comparable tasks and quality outcomes, not total-only comparisons.
- Costs, budgets, billing/cache relationships, and official plan mappings remain unconfirmed and are not implemented in this round.
- Measure response times and scale limits using synthetic data and approved real samples; “on-demand loading” is not performance verification.

## 9. Basis for This Analysis

- The user's request: analyze product goals, recommend token-detail features, and provide an MVP document at the project root.
- `README.md`: positioning, current usage, 0.2.2 features, and data-security boundaries.
- `docs/REQUIREMENTS.md`: initial requirements, statistical definitions, time rules, and acceptance constraints.
- `src/cli.ts`: actual version and command entry points.
- `src/store.ts`, `src/server.ts`: current usage, model groups, turns, and individual-call queries.
- `web/app.js`: visible lists, charts, and interaction entry points.

This document recommends product scope. It does not modify the program or claim that new P0/P1 features are complete.
