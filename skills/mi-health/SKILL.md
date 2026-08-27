---
name: mi-health
description: Use when querying or analyzing Xiaomi Mi Fitness data through MCP.
version: 1.1.0
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

- `health_analyze`: preferred for “分析”, “趋势”, “最近怎么样”, “和平时相比”,
  weekly reviews, or any request requiring interpretation rather than a raw
  value. It computes deterministic personal-baseline statistics.
- `health_latest`: latest compact overview of steps, sleep, and heart rate.
- `health_steps`: daily step totals for 1 to 30 days.
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
   - `current_day.steps` and `current_day.heart_rate` are partial-day values.
     Report them separately; never compare them with completed days.
   - `missing_dates` are absent daily records. `missing_measurements` are dates
     whose record exists but the target value is blank, non-numeric, or
     negative. Both represent unknown coverage, never zero measurements.
   - `sync.lag_minutes` reports how old the newest returned record is. State a
     visible lag before interpreting absence as behavior.
   - `sleep_stages.unavailable_dates` means total sleep was present while the
     deep/light/REM breakdown was absent or all zero. Say the stage detail is
     unavailable; never say the user had zero deep sleep.
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
     day would distort the mean.
   - `comparison.status` is one of `above_baseline`, `below_baseline`,
     `within_baseline`, or `insufficient_data`.
   - `median_delta`, `median_ratio`, and `robust_z` describe magnitude; they are
     personal-history comparisons, not clinical severity scores.

4. Explain likely context without claiming causality. If steps and daily average
   heart rate rise together, say that increased activity may be a relevant
   context. Do not call the daily `avg_hr` resting heart rate, and do not infer
   HRV from these summaries.

5. Lead with a compact conclusion, then the evidence and data-quality caveats.
   A sound response distinguishes:

   - What the records directly show.
   - What differs from the user’s own baseline.
   - What remains unknown because of missing, partial, or low-coverage data.
   - Why the result is non-diagnostic.

If `comparison.status` is `insufficient_data`, do not improvise a trend. Report
that more completed days are needed. A single high or low day should be
reported as an observation, not treated as a sustained condition.

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
  that naps or discarded duplicate records did not occur.
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
