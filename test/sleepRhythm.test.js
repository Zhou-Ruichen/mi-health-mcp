import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSleepRhythm } from "../src/sleepRhythm.js";

// bedtime / wake_up_time 为当绝对 epoch 分钟 mod 1440 后的钟表分钟；
// total_duration 为分钟。
function record(date, bedtime, wakeUp, duration, isNap = false) {
  return {
    date,
    bedtime,
    wake_up_time: wakeUp,
    total_duration: duration,
    is_nap: isNap,
  };
}

function recordsForDates(dates, bedtime, wakeUp, duration) {
  return dates.map((date) => record(date, bedtime, wakeUp, duration));
}

// 2026-01-05 是周一。
const WEEKDAY_DATES = [
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09",
  "2026-01-12",
  "2026-01-13",
  "2026-01-14",
  "2026-01-15",
  "2026-01-16",
];
const WEEKEND_DATES = [
  "2026-01-10",
  "2026-01-11",
  "2026-01-17",
  "2026-01-18",
];

test("analyzeSleepRhythm computes medians over a 14-day window with cross-midnight sleeps", () => {
  // 14 天窗口：2025-12-29 至 2026-01-11，均为主睡眠，23:30 入睡、07:00 起床、450 分钟。
  const dates = [];
  for (let offset = -13; offset <= 0; offset += 1) {
    dates.push(
      new Date(Date.parse("2026-01-11T00:00:00Z") + offset * 86400 * 1000)
        .toISOString()
        .slice(0, 10),
    );
  }
  const result = analyzeSleepRhythm(
    recordsForDates(dates, 23 * 60 + 30, 7 * 60, 450),
    { currentDate: "2026-01-11", days: 14 },
  );

  assert.equal(result.data_quality.valid_records, 14);
  assert.equal(result.data_quality.missing_days, 0);
  assert.equal(result.data_quality.naps_excluded, 0);
  assert.deepEqual(result.schedule.bedtime, {
    median: "23:30",
    median_minutes: 1410,
    mad_minutes: 0,
  });
  assert.deepEqual(result.schedule.wake_up_time, {
    median: "07:00",
    median_minutes: 420,
    mad_minutes: 0,
  });
  assert.deepEqual(result.schedule.duration, {
    median_minutes: 450,
    mad_minutes: 0,
  });
  // 相邻两天入睡时刻相同，入睡偏移为 0。
  assert.equal(result.social_jetlag_minutes, 0);
  // 工作日 10 条、周末 4 条，两组都达到 3 条下限。
  assert.equal(result.weekday_vs_weekend.weekday.records, 10);
  assert.equal(result.weekday_vs_weekend.weekend.records, 4);
  assert.equal(result.weekday_vs_weekend.weekday.duration.median_minutes, 450);
  // 最近 7 天（01-05 至 01-11）与基线（2025-12-29 至 01-04）各 7 条。
  assert.equal(result.recent_shift.recent.records, 7);
  assert.equal(result.recent_shift.baseline.records, 7);
  assert.equal(result.recent_shift.bedtime_shift_minutes, 0);
  assert.equal(result.recent_shift.duration_shift_minutes, 0);
  assert.equal(result.non_diagnostic, true);
});

test("analyzeSleepRhythm keeps the circular median across midnight", () => {
  const result = analyzeSleepRhythm(
    [
      record("2026-01-05", 23 * 60, 6 * 60, 420),
      record("2026-01-06", 60, 8 * 60, 420),
    ],
    { currentDate: "2026-01-11", days: 14 },
  );

  // 23:00 与 01:00 的环形中位数在 00:00 附近，而不是 12:00。
  const minutes = result.schedule.bedtime.median_minutes;
  assert.ok(minutes <= 5 || minutes >= 1435, `expected ~00:00, got ${result.schedule.bedtime.median}`);
});

test("analyzeSleepRhythm excludes nap records and reports them in data_quality", () => {
  const dates = [
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
    "2026-01-08",
    "2026-01-09",
  ];
  const records = [
    ...recordsForDates(dates, 23 * 60, 7 * 60, 480),
    record("2026-01-06", 14 * 60, 14 * 60 + 30, 30, true),
    record("2026-01-08", 15 * 60, 15 * 60 + 45, 45, true),
  ];
  const result = analyzeSleepRhythm(records, { currentDate: "2026-01-11", days: 14 });

  assert.equal(result.data_quality.valid_records, 5);
  assert.equal(result.data_quality.naps_excluded, 2);
  assert.equal(result.schedule.duration.median_minutes, 480);
});

test("analyzeSleepRhythm counts missing dates without treating them as zero", () => {
  // 窗口 2026-01-05 至 2026-01-11（7 天），只有 4 天有记录。
  const result = analyzeSleepRhythm(
    recordsForDates(
      ["2026-01-05", "2026-01-06", "2026-01-09", "2026-01-10"],
      23 * 60,
      7 * 60,
      480,
    ),
    { currentDate: "2026-01-11", days: 7 },
  );

  assert.equal(result.data_quality.valid_records, 4);
  assert.equal(result.data_quality.missing_days, 3);
  assert.deepEqual(result.data_quality.missing_dates, [
    "2026-01-07",
    "2026-01-08",
    "2026-01-11",
  ]);
  assert.ok(result.limitations.some((line) => line.includes("3 天无有效主睡眠记录")));
});

test("analyzeSleepRhythm returns null weekend group with a limitation when records are few", () => {
  // 5 条全是工作日记录，周末为 0。
  const result = analyzeSleepRhythm(
    recordsForDates(
      ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"],
      23 * 60,
      7 * 60,
      480,
    ),
    { currentDate: "2026-01-11", days: 7 },
  );

  assert.equal(result.weekday_vs_weekend.weekday.records, 5);
  assert.equal(result.weekday_vs_weekend.weekend, null);
  assert.ok(result.limitations.some((line) => line.includes("工作日或周末的有效记录不足 3 条")));
});

test("analyzeSleepRhythm skips recent shift when recent or baseline has fewer than 3 records", () => {
  // 最近 7 天（01-05 至 01-11）有 2 条，基线有 3 条。
  const result = analyzeSleepRhythm(
    [
      ...recordsForDates(["2026-01-01", "2026-01-02", "2026-01-03"], 23 * 60, 7 * 60, 480),
      ...recordsForDates(["2026-01-10", "2026-01-11"], 22 * 60, 6 * 60, 480),
    ],
    { currentDate: "2026-01-11", days: 14 },
  );

  assert.equal(result.recent_shift, null);
  assert.ok(result.limitations.some((line) => line.includes("未计算近期偏移")));
});

test("analyzeSleepRhythm flags suspicious durations in limitations", () => {
  const result = analyzeSleepRhythm(
    [
      ...recordsForDates(
        ["2026-01-05", "2026-01-06", "2026-01-07"],
        23 * 60,
        7 * 60,
        480,
      ),
      record("2026-01-08", 22 * 60, 20 * 60, 22 * 60), // 1320 分钟 > 16 小时
    ],
    { currentDate: "2026-01-11", days: 7 },
  );

  assert.equal(result.data_quality.suspicious_records, 1);
  assert.equal(result.data_quality.valid_records, 3);
  assert.ok(result.limitations.some((line) => line.includes("超过 16 小时或少于 1 小时")));
});

test("analyzeSleepRhythm computes recent shift toward later bedtimes", () => {
  const baselineDates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];
  const recentDates = ["2026-01-09", "2026-01-10", "2026-01-11"];
  const records = [
    ...recordsForDates(baselineDates, 23 * 60, 7 * 60, 420),
    ...recordsForDates(recentDates, 23 * 60 + 60, 7 * 60 + 60, 420),
  ];
  const result = analyzeSleepRhythm(records, { currentDate: "2026-01-11", days: 14 });

  assert.equal(result.recent_shift.baseline.records, 4);
  assert.equal(result.recent_shift.recent.records, 3);
  assert.equal(result.recent_shift.bedtime_shift_minutes, 60);
  assert.equal(result.recent_shift.wake_shift_minutes, 60);
  assert.equal(result.recent_shift.duration_shift_minutes, 0);
});

test("analyzeSleepRhythm rejects invalid options", () => {
  assert.throws(
    () => analyzeSleepRhythm([], { currentDate: "2026-1-11", days: 14 }),
    TypeError,
  );
  assert.throws(
    () => analyzeSleepRhythm([], { currentDate: "2026-01-11", days: 31 }),
    RangeError,
  );
  assert.throws(
    () => analyzeSleepRhythm([], { currentDate: "2026-01-11", days: 0 }),
    RangeError,
  );
});
