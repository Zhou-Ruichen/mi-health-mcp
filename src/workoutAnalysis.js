import { median } from "simple-statistics";

import { validateOptions } from "./analysis.js";

const DAY_MS = 86400 * 1000;

function shiftDate(date, deltaDays) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + deltaDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function sumValid(sessions, key) {
  return sessions.reduce(
    (total, session) => total + (nonNegativeNumber(session?.[key]) ?? 0),
    0,
  );
}

function countWith(sessions, predicate) {
  return sessions.filter(predicate).length;
}

function windowStats(sessions) {
  const activeDates = new Set(
    sessions.map((session) => session?.date).filter(Boolean),
  );
  return {
    session_count: sessions.length,
    active_days: activeDates.size,
    total_duration_seconds: sumValid(sessions, "duration_seconds"),
  };
}

function windowRange(currentDate, index, width) {
  return {
    start_date: shiftDate(currentDate, -(index + 1) * width + 1),
    end_date: shiftDate(currentDate, -index * width),
  };
}

function sessionsInRange(sessions, start, end) {
  return sessions.filter(
    (session) => session?.date && session.date >= start && session.date <= end,
  );
}

function compareMetric(recentValue, baselineMedian, completeWindows) {
  if (completeWindows < 2) return "insufficient_data";
  if (baselineMedian === 0) {
    return recentValue > 0 ? "above_baseline" : "within_baseline";
  }
  const ratio = recentValue / baselineMedian;
  if (ratio >= 1.25) return "above_baseline";
  if (ratio <= 0.75) return "below_baseline";
  return "within_baseline";
}

function groupSportTypes(sessions) {
  const byType = new Map();
  for (const session of sessions) {
    const key = typeof session?.sport_type === "string" && session.sport_type
      ? session.sport_type
      : null;
    const entry = byType.get(key) || {
      sport_type: key,
      activeDates: new Set(),
      session_count: 0,
      duration_seconds: 0,
    };
    entry.session_count += 1;
    if (session?.date) entry.activeDates.add(session.date);
    entry.duration_seconds += nonNegativeNumber(session?.duration_seconds) ?? 0;
    byType.set(key, entry);
  }
  return [...byType.values()]
    .map(({ activeDates, ...entry }) => ({
      ...entry,
      active_days: activeDates.size,
    }))
    .sort((left, right) =>
      right.session_count - left.session_count ||
      right.duration_seconds - left.duration_seconds ||
      String(left.sport_type).localeCompare(String(right.sport_type)));
}

export function analyzeWorkoutSessions(sessions, options) {
  const { currentDate, days, recentDays } = validateOptions(options);
  const nowSeconds = options?.nowSeconds;
  const windowStart = shiftDate(currentDate, -(days - 1));
  const inWindow = (Array.isArray(sessions) ? sessions : []).filter(
    (session) => session?.date && session.date >= windowStart && session.date <= currentDate,
  );

  const hasDuration = (session) => nonNegativeNumber(session?.duration_seconds) !== null;
  const times = inWindow
    .map((session) => nonNegativeNumber(session?.start_time))
    .filter((value) => value !== null);
  const latestTime = times.length > 0 ? Math.max(...times) : null;
  const sessionDates = inWindow
    .map((session) => session.date)
    .sort();
  const latestDate = sessionDates.at(-1) ?? null;

  const sameDay = new Map();
  for (const session of inWindow) {
    sameDay.set(session.date, (sameDay.get(session.date) || 0) + 1);
  }

  const recentRange = windowRange(currentDate, 0, recentDays);
  const recentSessions = sessionsInRange(
    inWindow,
    recentRange.start_date,
    recentRange.end_date,
  );
  const recentStats = windowStats(recentSessions);
  const recentDurations = recentSessions
    .map((session) => nonNegativeNumber(session?.duration_seconds))
    .filter((value) => value !== null);
  const recentDistances = recentSessions
    .map((session) => nonNegativeNumber(session?.distance))
    .filter((value) => value !== null);
  const recentCalories = recentSessions
    .map((session) => nonNegativeNumber(session?.calories))
    .filter((value) => value !== null);

  const baselineWindows = [];
  for (let index = 1; ; index += 1) {
    const range = windowRange(currentDate, index, recentDays);
    if (range.start_date < windowStart) break;
    baselineWindows.push({
      range,
      stats: windowStats(sessionsInRange(inWindow, range.start_date, range.end_date)),
    });
  }
  const completeWindows = baselineWindows.length;
  const baselineMedians = (key) => completeWindows > 0
    ? median(baselineWindows.map(({ stats }) => stats[key]))
    : null;

  return {
    data_quality: {
      session_count: inWindow.length,
      sessions_with_duration: countWith(inWindow, hasDuration),
      sessions_with_distance: countWith(inWindow, (session) => nonNegativeNumber(session?.distance) !== null),
      sessions_with_calories: countWith(inWindow, (session) => nonNegativeNumber(session?.calories) !== null),
      sessions_with_heart_rate: countWith(
        inWindow,
        (session) =>
          nonNegativeNumber(session?.avg_hr) !== null ||
          nonNegativeNumber(session?.max_hr) !== null,
      ),
      same_day_multiple_sessions: [...sameDay.entries()]
        .filter(([, count]) => count > 1)
        .map(([date, count]) => ({ date, session_count: count })),
      sync: {
        latest_workout_time: latestTime,
        lag_hours: latestTime !== null && Number.isFinite(nowSeconds)
          ? Math.round(Math.max(0, nowSeconds - latestTime) / 360) / 10
          : null,
      },
    },
    recent: {
      session_count: recentStats.session_count,
      active_days: recentStats.active_days,
      total_duration_seconds: recentStats.total_duration_seconds,
      total_distance: recentDistances.length > 0
        ? recentDistances.reduce((total, value) => total + value, 0)
        : null,
      total_calories: recentCalories.length > 0
        ? recentCalories.reduce((total, value) => total + value, 0)
        : null,
      sport_types: groupSportTypes(recentSessions),
      longest_session_seconds: recentDurations.length > 0
        ? Math.max(...recentDurations)
        : null,
      days_since_last_workout: latestDate === null
        ? null
        : Math.round(
          (Date.parse(`${currentDate}T00:00:00Z`) -
            Date.parse(`${latestDate}T00:00:00Z`)) / DAY_MS,
        ),
    },
    baseline: {
      complete_windows: completeWindows,
      per_window: baselineWindows.map(({ range, stats }) => ({
        start_date: range.start_date,
        end_date: range.end_date,
        ...stats,
      })),
      median_session_count: baselineMedians("session_count"),
      median_active_days: baselineMedians("active_days"),
      median_duration_seconds: baselineMedians("total_duration_seconds"),
    },
    comparison: {
      session_count: compareMetric(
        recentStats.session_count,
        baselineMedians("session_count"),
        completeWindows,
      ),
      active_days: compareMetric(
        recentStats.active_days,
        baselineMedians("active_days"),
        completeWindows,
      ),
      duration: compareMetric(
        recentStats.total_duration_seconds,
        baselineMedians("total_duration_seconds"),
        completeWindows,
      ),
      non_diagnostic: true,
    },
  };
}
