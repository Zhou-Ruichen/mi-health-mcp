import assert from "node:assert/strict";
import test from "node:test";

import { analyzeWorkoutSessions } from "../src/workoutAnalysis.js";

const CURRENT_DATE = "2026-08-28";

function session(date, fields = {}) {
  const time = Date.parse(`${date}T06:00:00Z`) / 1000;
  return { date, start_time: time, time, ...fields };
}

function analyze(sessions, overrides = {}) {
  return analyzeWorkoutSessions(sessions, {
    currentDate: CURRENT_DATE,
    days: 28,
    recentDays: 7,
    nowSeconds: Date.parse(`${CURRENT_DATE}T12:00:00Z`) / 1000,
    ...overrides,
  });
}

test("counts every same-day session and reports the overlap", () => {
  const result = analyze([
    session("2026-08-27", {
      duration_seconds: 1800,
      distance: 5000,
      calories: 350,
      avg_hr: 150,
      sport_type: "outdoor_run",
    }),
    session("2026-08-27", { sport_type: "outdoor_run" }),
    session("2026-08-20", { duration_seconds: 3600, sport_type: "swim" }),
  ]);

  assert.equal(result.data_quality.session_count, 3);
  assert.equal(result.data_quality.sessions_with_duration, 2);
  assert.equal(result.data_quality.sessions_with_distance, 1);
  assert.equal(result.data_quality.sessions_with_calories, 1);
  assert.equal(result.data_quality.sessions_with_heart_rate, 1);
  assert.deepEqual(result.data_quality.same_day_multiple_sessions, [
    { date: "2026-08-27", session_count: 2 },
  ]);
  assert.equal(result.recent.session_count, 2);
  assert.equal(result.recent.active_days, 1);
  assert.equal(result.recent.total_duration_seconds, 1800);
  assert.equal(result.recent.longest_session_seconds, 1800);
  assert.equal(result.recent.total_distance, 5000);
  assert.equal(result.recent.total_calories, 350);
  assert.equal(result.recent.days_since_last_workout, 1);
  assert.deepEqual(
    result.baseline.per_window.map(({ session_count }) => session_count),
    [1, 0, 0],
  );
  assert.equal(result.baseline.complete_windows, 3);
  assert.equal(result.baseline.median_session_count, 0);
  assert.equal(result.comparison.session_count, "above_baseline");
  assert.equal(result.comparison.active_days, "above_baseline");
  assert.equal(result.comparison.duration, "above_baseline");
  assert.equal(result.comparison.non_diagnostic, true);
});

test("invalid, negative, and missing fields are excluded instead of zeroed", () => {
  const result = analyze([
    session("2026-08-27", {
      duration_seconds: -100,
      distance: "abc",
      calories: "",
      avg_hr: -5,
    }),
    session("2026-08-26", { duration_seconds: 600, distance: 8000, calories: 400 }),
  ]);

  assert.equal(result.data_quality.sessions_with_duration, 1);
  assert.equal(result.data_quality.sessions_with_distance, 1);
  assert.equal(result.data_quality.sessions_with_calories, 1);
  assert.equal(result.data_quality.sessions_with_heart_rate, 0);
  assert.equal(result.recent.total_duration_seconds, 600);
  assert.equal(result.recent.longest_session_seconds, 600);
  assert.equal(result.recent.total_distance, 8000);
  assert.equal(result.recent.total_calories, 400);
});

test("totals stay unknown when no session carries a valid field", () => {
  const result = analyze([session("2026-08-27", { duration_seconds: 900 })]);

  assert.equal(result.recent.total_distance, null);
  assert.equal(result.recent.total_calories, null);
  assert.equal(result.recent.longest_session_seconds, 900);
});

test("partitions sessions by calendar windows without backfilling", () => {
  const result = analyze([
    session("2026-08-25", { duration_seconds: 600 }),
    session("2026-08-18", { duration_seconds: 600 }),
    session("2026-08-10", { duration_seconds: 1200 }),
    session("2026-08-11", { duration_seconds: 1200 }),
    session("2026-08-12", { duration_seconds: 1200 }),
    session("2026-08-03", { duration_seconds: 600 }),
    session("2026-07-31", { duration_seconds: 9999 }),
  ]);

  assert.equal(result.data_quality.session_count, 6);
  assert.equal(result.recent.session_count, 1);
  assert.deepEqual(
    result.baseline.per_window.map(
      ({ start_date, end_date, session_count, total_duration_seconds }) => ({
        start_date,
        end_date,
        session_count,
        total_duration_seconds,
      }),
    ),
    [
      { start_date: "2026-08-15", end_date: "2026-08-21", session_count: 1, total_duration_seconds: 600 },
      { start_date: "2026-08-08", end_date: "2026-08-14", session_count: 3, total_duration_seconds: 3600 },
      { start_date: "2026-08-01", end_date: "2026-08-07", session_count: 1, total_duration_seconds: 600 },
    ],
  );
  assert.equal(result.baseline.median_session_count, 1);
  assert.equal(result.baseline.median_duration_seconds, 600);
  assert.equal(result.comparison.session_count, "within_baseline");
  assert.equal(result.comparison.duration, "within_baseline");
});

test("returns insufficient_data when fewer than two complete baseline windows exist", () => {
  const result = analyze(
    [session("2026-08-25", { duration_seconds: 600 })],
    { days: 8, recentDays: 7 },
  );

  assert.equal(result.baseline.complete_windows, 0);
  assert.deepEqual(result.baseline.per_window, []);
  assert.equal(result.baseline.median_session_count, null);
  assert.equal(result.baseline.median_active_days, null);
  assert.equal(result.baseline.median_duration_seconds, null);
  assert.equal(result.comparison.session_count, "insufficient_data");
  assert.equal(result.comparison.active_days, "insufficient_data");
  assert.equal(result.comparison.duration, "insufficient_data");
  assert.equal(result.comparison.non_diagnostic, true);
});

test("groups sport types and keeps unknown types as null", () => {
  const result = analyze([
    session("2026-08-27", { duration_seconds: 1800, sport_type: "outdoor_run" }),
    session("2026-08-26", { duration_seconds: 900, sport_type: "outdoor_run" }),
    session("2026-08-25", { duration_seconds: 3600, sport_type: "swim" }),
    session("2026-08-24", { duration_seconds: 600 }),
  ]);

  assert.deepEqual(result.recent.sport_types, [
    { sport_type: "outdoor_run", session_count: 2, active_days: 2, duration_seconds: 2700 },
    { sport_type: "swim", session_count: 1, active_days: 1, duration_seconds: 3600 },
    { sport_type: null, session_count: 1, active_days: 1, duration_seconds: 600 },
  ]);
});

test("reports days_since_last_workout and sync lag independently", () => {
  const start = Date.parse("2026-08-25T06:00:00Z") / 1000;
  const result = analyze([
    session("2026-08-25", { duration_seconds: 1800, start_time: start }),
  ]);

  assert.equal(result.recent.days_since_last_workout, 3);
  assert.equal(result.data_quality.sync.latest_workout_time, start);
  assert.equal(result.data_quality.sync.lag_hours, 78);
});

test("counts a current-day session as complete with zero days since", () => {
  const result = analyze([
    session("2026-08-28", { duration_seconds: 1800 }),
  ]);

  assert.equal(result.recent.session_count, 1);
  assert.equal(result.recent.active_days, 1);
  assert.equal(result.recent.days_since_last_workout, 0);
  assert.equal(result.comparison.session_count, "above_baseline");
});

test("marks an empty recent window below a nonzero baseline", () => {
  const result = analyze([
    session("2026-08-20", { duration_seconds: 1800 }),
    session("2026-08-10", { duration_seconds: 1800 }),
    session("2026-08-03", { duration_seconds: 1800 }),
  ]);

  assert.equal(result.recent.session_count, 0);
  assert.equal(result.recent.active_days, 0);
  assert.equal(result.recent.total_duration_seconds, 0);
  assert.equal(result.recent.days_since_last_workout, 8);
  assert.equal(result.baseline.median_session_count, 1);
  assert.equal(result.comparison.session_count, "below_baseline");
  assert.equal(result.comparison.active_days, "below_baseline");
  assert.equal(result.comparison.duration, "below_baseline");
});

test("reports an empty history as zero counts with null extras", () => {
  const result = analyze([]);

  assert.deepEqual(result.data_quality.same_day_multiple_sessions, []);
  assert.equal(result.data_quality.sync.latest_workout_time, null);
  assert.equal(result.data_quality.sync.lag_hours, null);
  assert.equal(result.recent.days_since_last_workout, null);
  assert.deepEqual(result.recent.sport_types, []);
  assert.equal(result.baseline.complete_windows, 3);
  assert.equal(result.baseline.median_session_count, 0);
});

test("validates window options before analyzing", () => {
  assert.throws(
    () => analyzeWorkoutSessions([], {
      currentDate: "2026-02-29",
      days: 28,
      recentDays: 7,
    }),
    /currentDate.*YYYY-MM-DD.*calendar date/i,
  );
  assert.throws(
    () => analyzeWorkoutSessions([], {
      currentDate: CURRENT_DATE,
      days: 7,
      recentDays: 7,
    }),
    /days.*integer.*8.*30/i,
  );
  assert.throws(
    () => analyzeWorkoutSessions([], {
      currentDate: CURRENT_DATE,
      days: 8,
      recentDays: 8,
    }),
    /recentDays.*less than days/i,
  );
});
