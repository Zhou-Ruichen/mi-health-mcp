---
name: mi-health
description: Use when querying or analyzing Xiaomi Mi Fitness data through MCP.
version: 1.4.0
license: GPL-3.0
metadata:
  hermes:
    tags: [health, xiaomi, mcp, quantified-self]
    related_skills: [journal, weekly-review-planning, apple-reminders, calendar]
---

# Xiaomi Health Queries And Analysis

Use the configured `mi_health` MCP server for Xiaomi Mi Fitness steps, sleep,
heart-rate summaries, account state, and authorized relative data. Never ask
the user to paste a Worker Authorization token, Xiaomi cookie, `passToken`, or
session credential into chat.

## When To Use

Use this skill when the user asks for:

- Their own or an authorized relative's recent steps, sleep, or heart rate.
- A health trend, personal baseline comparison, weekly review, or explanation
  of whether recent wearable data differs from usual.
- Xiaomi health login/session status.
- An explicitly requested journal entry, reminder, calendar item, or scheduled
  summary based on Xiaomi health data.

Treat wearable summaries as wellness data, not clinical measurements. Do not
diagnose illness, infer medication needs, or present a trend flag as a medical
alert.

## Choose The Target

- For “I”, “me”, “my”, “本人”, or equivalent requests, omit `target` or pass
  `target: "self"`. Do not send `relative_uid`.
- For a relative or family member, call `health_relatives` first unless the user
  already selected a `relative_uid`. Pass `target: "relative"` and that exact
  `relative_uid`; never guess or select the first relative.
- If the user names a relative ambiguously, show only the safe identifying
  fields returned by `health_relatives` and ask which one they mean.

## Choose The Tool

- `health_workout_analyze`: preferred for “这周运动了没有”, “运动了多少次”,
  “主要做了什么运动”, or “和前几周比运动量如何”. It performs one bounded
  workout query (default 28 days, recent window 7 days) and requires no
  separate `health_workouts` call for the same window.
- `health_analyze`: preferred for “分析”, “趋势”, “最近怎么样”, “和平时相比”,
  weekly reviews, or any request requiring interpretation rather than a raw
  value. It computes deterministic personal-baseline statistics.
- `health_latest`: latest compact overview of steps, sleep, and heart rate.
- `health_steps`: daily step totals for 1 to 30 days.
- `health_workouts`: workout sessions (self only) for 1 to 30 days; per-session
  sport type, start/end time, duration, distance, calories, and avg/max heart
  rate when the upstream provides them. Not raw sensor streams, not daily step
  totals. Relative workout queries have no verified endpoint and are not
  supported.
- `health_workout_analyze`: personal workout-session analysis for the self
  account only. Reports the recent window's session count, active days,
  duration, and sport types, compares them with earlier equal-length calendar
  windows, and flags sync lag and same-day duplicates. Non-diagnostic; not
  training advice.
- `health_sleep`: one selected sleep summary per wake date for 1 to 30 days.
- `health_heart`: daily heart-rate statistics for 1 to 30 days; not raw PPG,
  ECG, RR intervals, or a complete sample stream.
- `health_me`: current Xiaomi account login state and non-secret identity.
- `health_relatives`: authorized relatives available for queries.
- `health_login_status`: current session state and login method.
- `health_login_refresh`: explicitly refresh the session from configured
  account secrets without returning credentials.

Use `days: 1` for a requested current value or last night, `days: 7` for a raw
recent series, and `health_analyze` with `days: 30`, `recent_days: 7` for an
unspecified trend. The supported analysis range is 8 to 30 days.

## Analysis Procedure

For a trend or interpretation request:

1. Call `health_analyze` with the correct target and an explicit IANA timezone
   representing the user’s current location, for example:

   ```json
   {
     "target": "self",
     "days": 30,
     "recent_days": 7,
     "timezone": "Europe/Berlin"
   }
   ```

   The timezone identifies the unfinished current date only. Never recalculate
   the dates returned by Xiaomi in another timezone.

2. Read `period` and `data_quality` before interpreting `metrics`:

   - Duplicate daily summaries are canonicalized to one deterministic record
     per date before statistics and quality counts.
   - `current_day.steps`, `current_day.distance`, `current_day.calories`, and
     `current_day.heart_rate` are partial-day values. Report them separately;
     never compare them with completed days.
   - `missing_dates` are absent daily records. `missing_measurements` are dates
     whose record exists but the target value is blank, non-numeric, or
     negative; they cover `steps`, `sleep_duration`, `heart_rate`, `distance`,
     and `calories`. Both represent unknown coverage, never zero measurements.
   - `sync.lag_minutes` reports how old the newest returned record is. State a
     visible lag before interpreting absence as behavior.
   - Each sleep record carries `sleep_stage_status`: `available` when at least
     one deep/light/REM duration is greater than 0; `unavailable` when total
     sleep duration is valid but every stage field is 0 or missing; `unknown`
     when total duration itself is invalid. When total sleep duration is valid
     but all stage fields are 0, the stage detail is unavailable; it does not
     mean deep or light sleep was actually zero, and it does not identify the
     recording device (the upstream provides no source field, so the source is
     unknown). `sleep_stages.unavailable_dates` lists the dates in the
     `unavailable` state; say the stage detail is unavailable; never say the
     user had zero deep sleep.
   - `heart_rate.low_sample_dates` are below half the completed-day sample-count
     median; `heart_rate.unknown_sample_dates` have no valid positive sample
     count. Both groups are excluded from heart-rate trend statistics, and
     `accepted_n` reports how many completed records remain.

3. Interpret each metric from the structured summaries:

   - `recent`: valid records that fall inside the most recent requested calendar
     window, normally seven dates. Missing or rejected dates are not backfilled
     with older records.
   - `baseline`: valid records on earlier requested dates.
   - `mean`, `median`, `min`, `max`, `q1`, `q3`, and `mad`: descriptive
     statistics. Prefer median and MAD/IQR when an extreme travel or exercise
     day would distort the mean. `distance` and `calories` follow the same
     baseline method as `steps`. Their values are passed through as returned by
     Xiaomi without unit conversion; `calories` is only "Xiaomi's returned
     calories", not active or resting calories, and neither metric carries
     medical or training interpretation.
   - `comparison.status` is one of `above_baseline`, `below_baseline`,
     `within_baseline`, or `insufficient_data`.
   - `median_delta`, `median_ratio`, and `robust_z` describe magnitude; they are
     personal-history comparisons, not clinical severity scores.

4. Explain likely context without claiming causality. If steps and daily average
   heart rate rise together, say that increased activity may be a relevant
   context. Do not call the daily `avg_hr` resting heart rate, and do not infer
   HRV from these summaries.

   For a request asking why a metric or load changed, add a read-only context
   pass after `health_analyze`:

   - Use the same date window as the health analysis for journal and calendar
     lookups. Do not search unrelated history broadly.
   - Treat health data as quantitative measurements, journal entries as
     evidence of what actually happened, and calendar events as plans or
     commitments. Never present a calendar plan alone as a completed activity.
   - Separate direct measurements, corroborated context, and plausible
     inference. Surface conflicts, missing context, and uncertain recollections
     instead of silently reconciling them.
   - Keep this pass read-only. Do not create or modify journal or calendar
     records unless the user explicitly asks.
   - Skip contextual lookup for a single raw value or simple table. For causal
     questions such as why load increased or where it came from, use it by
     default when the sources are available.

5. Lead with a compact conclusion, then the evidence and data-quality caveats.
   A sound response distinguishes:

   - What the records directly show.
   - What differs from the user’s own baseline.
   - What remains unknown because of missing, partial, or low-coverage data.
   - Why the result is non-diagnostic.

If `comparison.status` is `insufficient_data`, do not improvise a trend. Report
that more completed days are needed. A single high or low day should be
reported as an observation, not treated as a sustained condition.

When interpreting `health_workout_analyze`:

- A workout session is a complete event; sessions on the current calendar day
  count toward the recent window, and `days_since_last_workout` can be 0.
- `days_since_last_workout` and `sync.lag_hours` are separate checks. When the
  lag is large, absence of new records means the device has not synced, not
  that the user did not work out; say which one the data supports.
- Sessions on the same day are all counted and also listed under
  `same_day_multiple_sessions`; do not assert the device split one activity,
  and do not merge them.
- Missing or invalid duration/distance/calories stay out of the totals, and
  the coverage counts in `data_quality` show how many sessions carry each
  field. Zero totals from missing fields must not be reported as measured
  zeros.
- Do not infer workout intensity, training load, recovery, or hydration from
  session counts, durations, or heart-rate fields, and do not convert between
  step counts and workout durations.

## Explain Raw Results

When the user asks only for a value or table:

- Lead with the requested value and keep the answer compact.
- Treat missing fields or dates as unknown, not zero. Mention possible device
  synchronization delay when recent data is absent.
- Steps are daily totals in the compact response. Do not sum totals across
  records again.
- Heart results contain daily `sample_count`, `avg_hr`, `min_hr`, `max_hr`, and
  `latest_hr`; they are not a raw physiological signal.
- Sleep returns at most one selected main record per wake date. Do not infer
  that naps or discarded duplicate records did not occur. Each record's
  `sleep_stage_status` tells whether stage detail is `available`,
  `unavailable` (total duration valid, stage breakdown absent or all zero), or
  `unknown` (no valid total duration). Zero stage fields never mean zero deep
  or light sleep.
- `health_workouts` returns one entry per recorded workout session, only with
  fields the upstream provided; absent fields are omitted, never invented.
  Distance and calories are raw Xiaomi values with no unit conversion, and
  `calories` is not interpreted as active calories.
- Respect the dates returned by the MCP server.

## Handle Login

When a health query reports an authentication or session error, call
`health_login_status`. A valid cached QR session can make this tool report
`logged_in` without testing newly configured account secrets. Call
`health_login_refresh` only when the user explicitly asks to validate or
replace that cached session. `XIAOMI_USER_ID` and `XIAOMI_PASS_TOKEN` are
required for refresh; a matching browser `XIAOMI_DEVICE_ID` is optional.

Do not call refresh speculatively because it performs an account login
exchange. `health_login_start` and `health_login_poll` exist for compatibility,
but Xiaomi can reject QR login with error `70036`; do not describe QR login as
universally supported or automatically retry it.

## Coordinate With Other Skills

- Do not write health results to notes, memory, reminders, calendars, or task
  systems unless the user explicitly requests that write.
- For an explicit journal request, query only the requested dates and
  measurements, then use `journal` to record a compact factual summary.
  Preserve missing values as unknown and do not add medical interpretation.
- For a causal health question, use `health_analyze` first, then read the
  matching journal and calendar window when available. Journal entries describe
  recalled events; calendar entries describe plans. Keep those reads separate
  from any explicit write request and report contradictions instead of choosing
  one silently.
- For an explicit weekly health review, use `health_analyze` first. Query raw
  series only when the user needs individual dates or when analysis metadata
  needs explanation. Use `weekly-review-planning` only for planning; do not
  turn measurements into tasks without approval.
- Use `apple-reminders` or `calendar` only when the user asks for a concrete
  reminder or event. Do not create one solely because a measurement differs
  from baseline.

## Scheduled Use

Do not create, edit, or delete a cron job unless the user explicitly asks.
Before attaching this skill, inspect scheduler status, jobs, and recent runs to
avoid duplicate summaries. A job whose prompt forbids tool calls or accepts
only its script’s JSON cannot use this skill merely by listing it.

After account refresh has been verified, prefer at most one daily health
summary over high-frequency polling because device synchronization can be
delayed. Cron prompts must be self-contained and specify target, analysis
window, current IANA timezone, delivery destination, and authentication-failure
behavior. Never place credentials in a cron prompt or switch to QR login after
a scheduled authentication failure.

## Verification

For a trend request, verification is complete only when:

1. `health_analyze` returned the intended target and timezone.
2. The partial current day was not included in completed-day comparisons.
3. Missing dates, sync lag, sleep-stage availability, and heart-rate sampling
   quality were checked before interpretation.
4. Any stated trend matches the returned `comparison.status` and summaries.
5. The answer is explicitly non-diagnostic and contains no medication advice.
