# Copilot Local Database Schema and Field Reference

## 1. Analysis Scope and Sources

- Analysis date: 2026-11-02.
- Database: `~/.copilot/session-store.db`, queried read-only with SQLite `mode=ro`.
- Schema version: `8`.
- Contains **17 tables**: 9 business tables, 1 version table, 1 full-text-search virtual table, 5 full-text-search internal tables, and 1 SQLite system table.
- No views or triggers.
- RTK `bypass` ran CodeGraph and SQLite queries without output transformation. CodeGraph verified project call relationships; SQLite verified actual table definitions.
- This document records structure and meaning only. It does not export conversation content, tool output, or other business records.

Types, defaults, and constraints come from the actual database. The database has no field comments; meanings derive from current project usage, SQLite behavior, or field names. Unconfirmed semantics are explicitly labeled inferred or pending confirmation.

### Attribute Conventions

| Marker | Meaning |
|---|---|
| PK | Primary key; composite keys are described after the table |
| AI | `AUTOINCREMENT` |
| NN | Explicit `NOT NULL` declaration |
| FK | Explicit foreign key |
| — | No additional declared constraint or default |
| Undeclared | SQLite column has no declared type; not equivalent to TEXT |
| now | Default expression `datetime('now')`, producing UTC timestamp text |

Ordinary columns without NN allow NULL. A TEXT primary key in an ordinary SQLite rowid table is not automatically NOT NULL; INTEGER PRIMARY KEY and WITHOUT ROWID primary keys have different non-null rules. Defaults apply only when a field is omitted on insertion, not as automatic updates.

## 2. Table Overview

| Table | Category | Main purpose | Direct dashboard query |
|---|---|---|---|
| `sessions` | Business | Session metadata | Yes |
| `assistant_usage_events` | Business | Model request usage and performance | Yes |
| `turns` | Business | User/assistant conversation turns | Yes |
| `checkpoints` | Business | Intermediate context summaries | No |
| `session_files` | Business | Files involved in sessions | No |
| `session_refs` | Business | Associated commits, PRs, issues, and other references | No |
| `dynamic_context_items` | Business | Dynamic context scoped to repository/branch | No |
| `forge_skill_proposals` | Business | Forge skill proposals and status, inferred from names | No |
| `forge_trajectory_events` | Business | Forge execution trajectories, inferred from names | No |
| `schema_version` | Metadata | Schema version | No |
| `search_index` | FTS5 virtual table | Full-text search | No |
| `search_index_config` | FTS5 internal table | Search configuration | No |
| `search_index_content` | FTS5 internal table | Original searchable content | No |
| `search_index_data` | FTS5 internal table | Inverted-index data blocks | No |
| `search_index_docsize` | FTS5 internal table | Document tokenization lengths | No |
| `search_index_idx` | FTS5 internal table | Index-segment locations | No |
| `sqlite_sequence` | SQLite system table | Autoincrement sequence state | No |

## 3. Business Table Fields

### 3.1 `sessions`: Session Metadata

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | TEXT | PK | — | Unique session identifier |
| `cwd` | TEXT | — | — | Session working directory |
| `repository` | TEXT | — | — | Repository |
| `host_type` | TEXT | — | — | Runtime host type; upstream values need confirmation |
| `branch` | TEXT | — | — | Git branch |
| `summary` | TEXT | — | — | Session summary |
| `created_at` | TEXT | — | now | Creation time |
| `updated_at` | TEXT | — | now | Update time; no automatic-update trigger |

The dashboard uses repository as project identity, falling back to cwd and displaying its directory name. Missing both uses the `Unspecified` group.

### 3.2 `assistant_usage_events`: Model Call Usage

This is the current dashboard's main token-statistics source. Model call count is the number of records.

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | PK, AI | — | Usage record ID |
| `session_id` | TEXT | NN, FK | — | Session, referencing `sessions.id` |
| `turn_index` | INTEGER | — | — | Upstream turn index; multiple model requests may share it. Lists retain the original value; individual details do not use it to associate whole-turn content |
| `agent_id` | TEXT | — | — | Agent identifier; generation rules need confirmation |
| `parent_tool_call_id` | TEXT | — | — | Parent tool call identifier, inferred from name |
| `model` | TEXT | NN | — | Requested model identifier |
| `input_tokens` | INTEGER | — | — | Model input tokens |
| `output_tokens` | INTEGER | — | — | Model output tokens |
| `cache_read_tokens` | INTEGER | — | — | Cache-read tokens |
| `cache_write_tokens` | INTEGER | — | — | Cache-write tokens |
| `reasoning_tokens` | INTEGER | — | — | Reasoning tokens; inclusion in output requires upstream definition |
| `total_nano_aiu` | INTEGER | — | — | nano-AIU usage, inferred from name; units/conversion need confirmation and must not be treated directly as money |
| `request_multiplier` | REAL | — | — | Request multiplier; billing/usage semantics need confirmation |
| `duration_ms` | INTEGER | — | — | Call duration in milliseconds |
| `time_to_first_token_ms` | INTEGER | — | — | First-token latency in milliseconds |
| `inter_token_latency_ms` | INTEGER | — | — | Inter-token latency metric in milliseconds; aggregation needs confirmation |
| `initiator` | TEXT | — | — | Request initiator/type; actual values need confirmation |
| `api_endpoint` | TEXT | — | — | API endpoint |
| `reasoning_effort` | TEXT | — | — | Reasoning-effort configuration |
| `finish_reason` | TEXT | — | — | Generation finish reason |
| `content_filter_triggered` | INTEGER | — | — | Content-filter flag; no CHECK restricting it to 0/1 |
| `token_details_json` | TEXT | — | — | Token-detail JSON text; internal format needs confirmation |
| `created_at` | TEXT | — | now | Usage time, used for date filters and strict unique time/metric matches to individual-call logs, not guessed turn attribution |
| `output_ttft_ms` | REAL | — | — | Inferred output first-token latency; distinction from the other field needs confirmation |
| `copilot_usage_model` | TEXT | — | — | Inferred Copilot usage-attribution model; mapping needs confirmation |

SQLite typing note: upstream may store REAL values in duration columns declared INTEGER.
Actual `duration_ms` and `time_to_first_token_ms` values may be finite fractional milliseconds or NULL;
preserve precision rather than applying strict integer validation used for tokens, request IDs, or turn indices.

There is no `total_tokens` column. The project computes at query/display time:

```text
Aggregate input = SUM(input_tokens)
Aggregate output = SUM(output_tokens)
Cache reads = SUM(cache_read_tokens)
Total tokens = Aggregate input + Aggregate output
Model calls = Number of usage records
```

Do not add cache reads again. Do not claim input-cache is “new input”: cache inclusion and billing definitions remain unproven.
Any NULL participating in a metric makes that aggregate unknown; do not manufacture zeros with coalesce. Empty sets may be zero.
Cache writes, reasoning, credits, money, and other performance fields do not participate in this display/cost conversion.

### 3.3 `turns`: Conversation Turns

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | PK, AI | — | Turn record ID |
| `session_id` | TEXT | NN, FK | — | Session, referencing `sessions.id` |
| `turn_index` | INTEGER | NN | — | Turn index within the session |
| `user_message` | TEXT | — | — | User message |
| `assistant_response` | TEXT | — | — | Assistant response |
| `timestamp` | TEXT | — | now | Conversation-record write time; locally observed to be written on the next input, not necessarily the original question time |

Unique constraint: `(session_id, turn_index)`.

“Whole-session records” reads this table and may lag immediate logs. Individual-call dialogs do not
require its records and do not present its final reply/user message as that call's output/complete input.
The original API reading a unique same-session/same-index turn remains compatible.

### 3.4 `checkpoints`: Session Checkpoints

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | PK, AI | — | Checkpoint record ID |
| `session_id` | TEXT | NN, FK | — | Session, referencing `sessions.id` |
| `checkpoint_number` | INTEGER | NN | — | Checkpoint number within the session |
| `title` | TEXT | — | — | Title |
| `overview` | TEXT | — | — | Overview |
| `history` | TEXT | — | — | History |
| `work_done` | TEXT | — | — | Completed work |
| `technical_details` | TEXT | — | — | Technical details |
| `important_files` | TEXT | — | — | Important-file information |
| `next_steps` | TEXT | — | — | Next steps |
| `created_at` | TEXT | — | now | Creation time |

Unique constraint: `(session_id, checkpoint_number)`.

### 3.5 `session_files`: Session File List

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | PK, AI | — | Record ID |
| `session_id` | TEXT | NN, FK | — | Session, referencing `sessions.id` |
| `file_path` | TEXT | NN | — | File path |
| `tool_name` | TEXT | — | — | Associated tool name |
| `turn_index` | INTEGER | — | — | Associated turn |
| `first_seen_at` | TEXT | — | now | First recorded time |

Unique constraint: `(session_id, file_path)`. This is a session-level file list, not a complete ledger of every file operation.

### 3.6 `session_refs`: Session References

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | PK, AI | — | Record ID |
| `session_id` | TEXT | NN, FK | — | Session, referencing `sessions.id` |
| `ref_type` | TEXT | NN | — | Reference type, e.g. commit, PR, issue; no enum constraint |
| `ref_value` | TEXT | NN | — | Reference value, e.g. hash, number, URL; upstream defines format |
| `turn_index` | INTEGER | — | — | Associated turn |
| `created_at` | TEXT | — | now | Recorded time |

Unique constraint: `(session_id, ref_type, ref_value)`.

### 3.7 `dynamic_context_items`: Dynamic Context

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `repository` | TEXT | NN, composite PK | — | Repository |
| `branch` | TEXT | NN, composite PK | — | Branch |
| `src` | TEXT | NN, composite PK | — | Source identifier, inferred from name |
| `name` | TEXT | NN, composite PK | — | Item name |
| `description` | TEXT | NN | `''` | Item description |
| `content` | TEXT | NN | `''` | Context content |
| `read_count` | INTEGER | NN | `0` | Inferred read count |
| `count` | INTEGER | NN | `0` | Count; what is counted needs confirmation |

Composite primary key: `(repository, branch, src, name)`.

### 3.8 `forge_skill_proposals`: Forge Skill Proposals

Business meaning is inferred from table/field names; the current project has no corresponding read/write code.

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | TEXT | PK | — | Proposal identifier |
| `repo_owner` | TEXT | — | — | Repository user/organization owner |
| `repo_name` | TEXT | — | — | Repository name |
| `git_root_path` | TEXT | NN | — | Repository root |
| `branch_name` | TEXT | NN | — | Branch name |
| `trigger_mode` | TEXT | NN | — | Trigger mode; values need confirmation |
| `status` | TEXT | NN | — | Proposal status; values need confirmation |
| `fingerprint` | TEXT | — | — | Fingerprint, presumably for identification/deduplication |
| `manifest_json` | TEXT | — | — | Manifest JSON text |
| `summary_json` | TEXT | — | — | Summary JSON text |
| `workspace_before_json` | TEXT | — | — | Pre-processing workspace JSON text |
| `superseded_by` | TEXT | — | — | Replacement proposal ID, inferred from name; no FK |
| `failure_reason` | TEXT | — | — | Failure reason |
| `created_at` | TEXT | NN | — | Creation time supplied by writer |
| `updated_at` | TEXT | NN | — | Update time supplied by writer |

No status-enum or JSON-format validation constraints.

### 3.9 `forge_trajectory_events`: Forge Execution Trajectories

Business meaning is inferred from table/field names; the current project has no corresponding read/write code.

| Field | Declared type | Attributes | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | PK, AI | — | Event ID |
| `session_id` | TEXT | NN, FK | — | Session, referencing `sessions.id` |
| `tool_call_id` | TEXT | — | — | Associated tool call |
| `turn_index` | INTEGER | — | — | Associated turn |
| `event_type` | TEXT | NN | — | Event type; values need confirmation |
| `command` | TEXT | — | — | Executed command |
| `output` | TEXT | — | — | Output content |
| `exit_code` | INTEGER | — | — | Process exit code |
| `event_key` | TEXT | — | — | Event property key |
| `event_value` | TEXT | — | — | Event property value |
| `created_at` | TEXT | — | now | Recorded time |

Do not treat this as a complete log of all tools. Current dashboard tool details come from `events.jsonl`, not this table.

## 4. Metadata, Search, and System Tables

### 4.1 `schema_version`

| Field | Declared type | Attributes | Meaning |
|---|---|---|---|
| `version` | INTEGER | NN | Schema version; `8` when queried |

No primary key or constraint limiting the table to one row.

### 4.2 `search_index`

An `fts5` full-text-search virtual table; columns have no ordinary SQL type declarations.

| Field | Attributes | Meaning |
|---|---|---|
| `content` | Full-text indexed | Searchable text |
| `session_id` | UNINDEXED | Session identifier, excluded from full-text tokenization |
| `source_type` | UNINDEXED | Source type, excluded from full-text tokenization |
| `source_id` | UNINDEXED | Source record identifier, excluded from full-text tokenization |
| `search_index` | Hidden column | Special FTS5 query control |
| `rank` | Hidden column | FTS5 relevance rank |

Hidden columns were confirmed with `PRAGMA table_xinfo(search_index)`. UNINDEXED does not prevent ordinary reads or condition filters.

### 4.3 `search_index_config`

| Field | Declared type | Attributes | Meaning |
|---|---|---|---|
| `k` | Undeclared | PK | FTS5 configuration key |
| `v` | Undeclared | — | FTS5 configuration value |

This is a WITHOUT ROWID table.

### 4.4 `search_index_content`

| Field | Declared type | Attributes | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK | FTS5 document rowid |
| `c0` | Undeclared | — | Virtual-table `content` |
| `c1` | Undeclared | — | Virtual-table `session_id` |
| `c2` | Undeclared | — | Virtual-table `source_type` |
| `c3` | Undeclared | — | Virtual-table `source_id` |

### 4.5 `search_index_data`

| Field | Declared type | Attributes | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK | Internal data-block ID |
| `block` | BLOB | — | FTS5 inverted index and internal data blocks |

### 4.6 `search_index_docsize`

| Field | Declared type | Attributes | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK | Document rowid |
| `sz` | BLOB | — | Encoded token counts per column |

These tokens are full-text-search terms, unrelated to model input/output tokens.

### 4.7 `search_index_idx`

| Field | Declared type | Attributes | Meaning |
|---|---|---|---|
| `segid` | Undeclared | Composite PK | Index-segment identifier |
| `term` | Undeclared | Composite PK | Term/prefix information for locating index segments |
| `pgno` | Undeclared | — | Index-page location |

Composite primary key: `(segid, term)`. This is a WITHOUT ROWID table. SQLite maintains all five FTS5 internal tables; manual modification is not recommended.

### 4.8 `sqlite_sequence`

| Field | Declared type | Attributes | Meaning |
|---|---|---|---|
| `name` | Undeclared | — | Table using AUTOINCREMENT |
| `seq` | Undeclared | — | That table's autoincrement sequence state |

Managed by SQLite.

## 5. Foreign Keys and Unique Constraints

```text
sessions.id
  ├─ assistant_usage_events.session_id
  ├─ turns.session_id
  ├─ checkpoints.session_id
  ├─ session_files.session_id
  ├─ session_refs.session_id
  └─ forge_trajectory_events.session_id
```

None of these six foreign keys declares cascading delete/update. Enforcement depends on the writer's `PRAGMA foreign_keys`; this read-only connection cannot prove other connections' settings.

`turn_index`, `agent_id`, `tool_call_id`, `parent_tool_call_id`, and `superseded_by` have no declared foreign keys.

| Table | Additional unique constraint |
|---|---|
| `turns` | `(session_id, turn_index)` |
| `checkpoints` | `(session_id, checkpoint_number)` |
| `session_files` | `(session_id, file_path)` |
| `session_refs` | `(session_id, ref_type, ref_value)` |

## 6. Explicitly Created Indexes

These 14 indexes have CREATE INDEX definitions, excluding SQLite automatic primary-key/unique indexes.

| Index | Table | Indexed fields, in order |
|---|---|---|
| `idx_assistant_usage_events_model` | `assistant_usage_events` | `model` |
| `idx_assistant_usage_events_session` | `assistant_usage_events` | `session_id, id` |
| `idx_assistant_usage_events_session_turn` | `assistant_usage_events` | `session_id, turn_index` |
| `idx_checkpoints_session` | `checkpoints` | `session_id` |
| `idx_dynamic_context_repo_branch` | `dynamic_context_items` | `repository, branch` |
| `idx_forge_skill_proposals_scope_fingerprint` | `forge_skill_proposals` | `git_root_path, branch_name, repo_owner, repo_name, fingerprint` |
| `idx_forge_skill_proposals_scope_status` | `forge_skill_proposals` | `git_root_path, branch_name, repo_owner, repo_name, status` |
| `idx_forge_trajectory_events_session` | `forge_trajectory_events` | `session_id, id` |
| `idx_forge_trajectory_events_tool_call` | `forge_trajectory_events` | `tool_call_id` |
| `idx_session_files_path` | `session_files` | `file_path` |
| `idx_session_refs_type_value` | `session_refs` | `ref_type, ref_value` |
| `idx_sessions_cwd` | `sessions` | `cwd` |
| `idx_sessions_repo` | `sessions` | `repository` |
| `idx_turns_session` | `turns` | `session_id` |

## 7. Current Project Database Usage

The current standalone entry is `src/cli.ts`; `src/store.ts` manages read-only SQLite snapshots,
and `src/query.ts` runs queries/log reads in a file-write-denied isolated process.

| Entry or feature | Tables read | Code |
|---|---|---|
| Read-only connection and queries | Shared query wrapper | `Store.snapshot` |
| Home `/api/dashboard` | `sessions`, `assistant_usage_events` | `Store.dashboard` |
| Session pagination and whole-session conversation `/api/sessions/<sid>` | Three main tables | `Store.session` |
| Turn totals and calls `/api/sessions/<sid>/rounds` | `sessions`, usage table | `Store.rounds` |
| Individual call `/api/sessions/<sid>/requests/<rid>/call` | Usage table and sibling logs | `Store.callAnchor`, `singleCall` |
| Same-turn tools `/api/sessions/<sid>/turns/<tid>/tools` | `turns`, sibling logs | `toolActivity` |

### Data-Definition Notes

- Filter days/months by each event's actual instant in OS local time, correctly handling DST; timezone-less SQLite TEXT is UTC.
- Input is the processed amount for every request; repeated historical context is not deduplicated by content.
- Retain original database turn indices; do not infer associations from adjacent message times or index offsets.
- Session details aggregate all requests in the current range by original index before turn pagination; turn 0 is separate from NULL “Turn not recorded.”
- Opening a turn lists calls only from that session, original index, and date range. Totals use the same scope and first/last times use valid call timestamps.
- Single-turn `token_trend` returns time, model, input/output/cache for all in-range calls, ordered by exact time and ID ascending, independently of call-list pagination.
- Lines plot individual usage rather than cumulative totals. NULL breaks lines; anomalous timestamps appear last as separate points. Database large integers remain exact in APIs/tooltips.
- Single-turn `/rounds/activities` verifies uniqueness against all usage records for the session, then associates every call in that turn/range during one log scan. It returns safe tool summaries/status only, not full input/output/arguments/results.
- Chart hover reuses whole-turn summaries rather than reading logs per point. Tools are actions initiated by this model output; their results may enter later calls' input. Adjacent metric differences are not new context, and exact per-tool/skill token allocation is not provided.
- The usage table has no `apiCallId` foreign key. Individual details require uniqueness in both database/log for session, agent, timestamp second, and model/token/cache/duration/initiator/finish-reason metrics.
- After a unique match, use `apiCallId` for model output and its `toolCallId` for execution records. Duplicate IDs, multiple candidates, cross-second matches, and missing metrics explicitly reject association.
- Complete input is shown only when explicitly linked by call ID and actually saved as `requestMessages`; never substitute user messages.
- Whole-session tools use a unique user message and `interactionId` to associate same-turn main-session tools, not an individual model call.
- Custom databases read only sibling `session-state/<sid>/events.jsonl`, never arbitrary log paths.
- Across day/month boundaries, filtering turn-start versus request-record time may cause turn totals to differ from session usage totals.
- The project does not implement model prices, cache discounts, or nano-AIU-to-money conversion.

## 8. Semantics Requiring Upstream Definitions

Schema alone cannot confirm `total_nano_aiu` conversion, `request_multiplier` rules, differences between the two first-token latency fields, `copilot_usage_model` mappings, what `dynamic_context_items.count` counts, Forge status enums, or JSON internals. This document does not treat these inferences as verified facts.

## 9. Version 1.0.104 Inspection and Support Boundaries

On 2026-11-02, read-only inspection of the actual native `/opt/homebrew/bin/copilot --version`
reported **GitHub Copilot CLI 1.0.104**. Old directory names in Homebrew paths are not runtime versions.
The telemetry-bearing shell shim was not executed. Private definitions embedded in native executables
are not a searchable public schema. The following key/type samples are from actual version records,
not invented upstream billing statements. No credentials were read, content exported, or data sent to third parties.

- At inspection: 976 sessions, 11060 turns, 19094 usage rows; 893 rows had agent_id.
  Usage turn_index/input/cache had no NULLs and cache>input count was 0. These statistics do not prove cache inclusion or turn offsets.
- 42 logs had session.start.data.copilotVersion 1.0.104. In 921 session.usage_record samples,
  outer data contained only usage, without turnIndex/agentId. usage contained apiCallId/providerCallId,
  but database requests lacked a corresponding verified request ID; similar usage/time is not enough to guess a join.
- user.message.data: content:str, interactionId:str, turnId:str, messageId:str;
  assistant.turn_start.data: turnId:str, interactionId:str;
  assistant.turn_end.data: turnId:str;
  assistant.message.data: content:str, interactionId:str, turnId:str, apiCallId:str.
- session.usage_record.data.usage: model:str, inputTokens:int, outputTokens:int,
  cacheReadTokens:int, apiCallId:str, accounting:dict, copilotUsage:dict.
- model.model_call_success.data.responseUsage: prompt_tokens:int, completion_tokens:int,
  total_tokens:int, prompt_tokens_details:dict. The reinspection script checks numerical relationships only, without exporting messages.
- Tool events include toolCallId, turnId, arguments/result; character counts use JSON Unicode characters, not tokens.
- Historical logs span 1.0.9..1.0.104. Common message/lifecycle fields are read structurally; unknown events contribute no tokens
  and imply no support for unknown billing semantics. Required-column or consumed-event-shape changes fail explicitly.
- `python3 inspect_semantics.py --copilot /opt/homebrew/bin/copilot` can repeat version, column,
  key/type/count, and numerical equality checks. Counts change with Copilot activity and are not fixed assertions.
- `python3 -m unittest -v test_app test_tokenboard` uses fixed synthetic samples for definitions/NULL/concurrency/unattributed records/
  WAL/read-only/time zones/incremental logs; `python3 verify_delivery.py` measures the time until written data appears in the visible Chrome DOM.

The initial historical index took 8.333s and a later read-only refresh 0.592s on that machine/data,
not a performance guarantee. Logs retain metadata and content offsets only; default HTTP does not
bulk-return content or tool output. Add/delete/replace/truncate events, partial trailing lines, and
complete malformed lines have regression cases. Source failures are explicit HTTP 503 responses
and page stale indicators.
