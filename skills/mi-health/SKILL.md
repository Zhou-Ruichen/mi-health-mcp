---
name: mi-health
description: Query and explain Xiaomi Mi Fitness steps, sleep, heart rate, account status, and authorized relative data through the mi_health MCP server. Use for personal or family health questions, recent health trends, Xiaomi health login, scheduled health summaries, or explicitly requested health entries, reviews, reminders, and calendar planning.
license: GPL-3.0
metadata:
  hermes:
    tags: [health, xiaomi, mcp]
    related_skills: [journal, weekly-review-planning, apple-reminders, calendar]
---

# Xiaomi Health Queries

Use the configured `mi_health` MCP server. Never ask the user to paste a Worker Authorization token, Xiaomi cookie, `passToken`, or session credential into chat.

## Choose The Target

- For "I", "me", "my", or equivalent requests, omit `target` or pass `target: "self"`. Do not send `relative_uid`.
- For a relative or family member, call `health_relatives` first unless the user already selected a `relative_uid`. Pass `target: "relative"` and that exact `relative_uid`; never guess or select the first relative.
- If the user names a relative ambiguously, show the safe identifying fields returned by `health_relatives` and ask which one they mean.

## Choose The Tool

- `health_latest`: latest compact overview of steps, sleep, and heart rate.
- `health_steps`: daily step totals for 1 to 30 days.
- `health_sleep`: one selected sleep summary per wake date for 1 to 30 days.
- `health_heart`: daily heart-rate statistics for 1 to 30 days.
- `health_me`: current Xiaomi account login state and non-secret account identity.
- `health_relatives`: authorized relatives available for queries.
- `health_login_status`: current session state and login method.
- `health_login_refresh`: explicitly refresh the session from configured account secrets without returning credentials.

Use `days: 1` for today or last night, `days: 7` for an unspecified recent trend, and the user's explicit value otherwise. The supported range is 1 to 30 days.

## Handle Login

When a health query reports an authentication or session error, call `health_login_status`. A valid cached QR session can make this tool report `logged_in` without testing newly configured account secrets. Call `health_login_refresh` only when the user explicitly asks to validate or replace that cached session. `XIAOMI_USER_ID` and `XIAOMI_PASS_TOKEN` are required for refresh; a matching browser `XIAOMI_DEVICE_ID` is optional. Do not call refresh speculatively because it performs an account login exchange. `health_login_start` and `health_login_poll` exist for compatibility, but Xiaomi can reject QR login with error `70036`; do not describe QR login as verified or automatically retry it.

## Coordinate With Other Skills

- Do not write health results to notes, memory, reminders, calendars, or task systems unless the user explicitly requests that write.
- For an explicit journal request, query only the requested dates and measurements, then use `journal` to record a compact factual summary. Preserve missing values as unknown and do not add medical interpretation.
- For an explicit weekly health review, query up to 7 days with `health_steps`, `health_sleep`, and `health_heart`. Report date coverage and synchronization gaps before interpreting trends. Use `weekly-review-planning` only for planning the review; do not turn measurements into tasks without approval.
- Use `apple-reminders` or `calendar` only when the user asks for a concrete reminder or event. Do not create one solely because a measurement looks unusual.

## Explain Results

- Lead with the requested value or trend. Keep the answer compact unless the user asks for details.
- Treat missing fields or dates as unknown, not zero. Mention possible device synchronization delay when recent data is absent.
- Steps are daily totals in the compact response. Do not sum totals across records again.
- Heart results are daily statistics such as `sample_count`, `avg_hr`, `min_hr`, `max_hr`, and `latest_hr`; they are not raw samples.
- Sleep returns at most one selected main record per wake date. Do not infer that naps or other discarded duplicate records did not occur.
- Respect the dates returned by the MCP server. Do not recalculate dates from timestamps in another timezone.
- Do not diagnose illness or recommend medication from these measurements. Clearly label any general interpretation as non-diagnostic.

## Scheduled Use

Do not create, edit, or delete a cron job unless the user explicitly asks. Before attaching this skill, inspect `hermes cron status`, `hermes cron list`, and recent runs to avoid duplicate summaries. A job whose prompt forbids tool calls or accepts only its script's JSON cannot use this skill merely by listing it. After account refresh has been verified, prefer at most one daily health summary over high-frequency polling because device synchronization is delayed. Cron prompts must be self-contained and must report authentication failures without exposing credentials or switching to QR login.
