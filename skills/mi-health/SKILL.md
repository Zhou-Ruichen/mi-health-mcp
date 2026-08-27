---
name: mi-health
description: Query and explain Xiaomi Mi Fitness steps, sleep, heart rate, account status, and authorized relative data through the mi_health MCP server. Use for questions about my health, recent health trends, family health data, Xiaomi health login, or scheduled health summaries.
license: GPL-3.0
metadata:
  hermes:
    tags: [health, xiaomi, mcp]
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

When a health query reports an authentication or session error, call `health_login_status`. If the user asks to refresh after configuring `XIAOMI_USER_ID`, `XIAOMI_PASS_TOKEN`, and the matching browser `XIAOMI_DEVICE_ID`, call `health_login_refresh`. Do not call it speculatively because it performs an account login exchange. `health_login_start` and `health_login_poll` exist for compatibility, but Xiaomi can reject QR login with error `70036`; do not describe QR login as verified or automatically retry it.

## Explain Results

- Lead with the requested value or trend. Keep the answer compact unless the user asks for details.
- Treat missing fields or dates as unknown, not zero. Mention possible device synchronization delay when recent data is absent.
- Steps are daily totals in the compact response. Do not sum totals across records again.
- Heart results are daily statistics such as `sample_count`, `avg_hr`, `min_hr`, `max_hr`, and `latest_hr`; they are not raw samples.
- Sleep returns at most one selected main record per wake date. Do not infer that naps or other discarded duplicate records did not occur.
- Respect the dates returned by the MCP server. Do not recalculate dates from timestamps in another timezone.
- Do not diagnose illness or recommend medication from these measurements. Clearly label any general interpretation as non-diagnostic.

## Scheduled Use

Do not create, edit, or delete a cron job unless the user explicitly asks. Before attaching this skill, inspect `hermes cron status`, `hermes cron list`, and recent runs to avoid duplicate summaries. Prefer adding `mi-health` to an existing briefing only when its schedule, timezone, delivery target, and model match the requested health summary. Cron prompts must be self-contained and must report authentication failures without exposing credentials or switching to QR login.
