import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { analyzeHealthSeries } from "../src/analysis.js";

function daily(date, values) {
  return { date, time: Date.parse(`${date}T12:00:00Z`) / 1000, ...values };
}

test("analysis separates the current activity day from completed-day baselines", () => {
  const steps = [
    daily("2026-08-01", { steps: 1000 }),
    daily("2026-08-02", { steps: 1100 }),
    daily("2026-08-03", { steps: 900 }),
    daily("2026-08-04", { steps: 1000 }),
    daily("2026-08-05", { steps: 3000 }),
    daily("2026-08-06", { steps: 3200 }),
    daily("2026-08-07", { steps: 3100 }),
    daily("2026-08-08", { steps: 50 }),
  ];

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    {
      currentDate: "2026-08-08",
      days: 8,
      recentDays: 3,
      nowSeconds: Date.parse("2026-08-08T12:30:00Z") / 1000,
    },
  );

  assert.deepEqual(result.current_day.steps, {
    date: "2026-08-08",
    steps: 50,
    status: "partial",
  });
  assert.equal(result.metrics.steps.recent.n, 3);
  assert.equal(result.metrics.steps.recent.median, 3100);
  assert.equal(result.metrics.steps.baseline.n, 4);
  assert.equal(result.metrics.steps.baseline.median, 1000);
  assert.equal(result.metrics.steps.comparison.status, "above_baseline");
  assert.equal(result.metrics.steps.comparison.non_diagnostic, true);
});

test("analysis treats zeroed sleep stages as unavailable and reports missing dates", () => {
  const sleep = [
    daily("2026-08-01", { total_duration: 420, sleep_deep_duration: 100, sleep_light_duration: 250 }),
    daily("2026-08-02", { total_duration: 390, sleep_deep_duration: 0, sleep_light_duration: 0 }),
    daily("2026-08-04", { total_duration: 450, sleep_deep_duration: 120, sleep_light_duration: 260 }),
    daily("2026-08-05", { total_duration: 430, sleep_deep_duration: 110, sleep_light_duration: 250 }),
    daily("2026-08-06", { total_duration: 440, sleep_deep_duration: 0, sleep_light_duration: 0 }),
    daily("2026-08-07", { total_duration: 460, sleep_deep_duration: 130, sleep_light_duration: 270 }),
    daily("2026-08-08", { total_duration: 410, sleep_deep_duration: 90, sleep_light_duration: 240 }),
  ];

  const result = analyzeHealthSeries(
    { steps: [], sleep, heart_rate: [] },
    {
      currentDate: "2026-08-08",
      days: 8,
      recentDays: 3,
      nowSeconds: Date.parse("2026-08-08T12:30:00Z") / 1000,
    },
  );

  assert.deepEqual(result.data_quality.missing_dates.sleep, ["2026-08-03"]);
  assert.deepEqual(result.data_quality.sleep_stages, {
    available_n: 5,
    unavailable_n: 2,
    unavailable_dates: ["2026-08-02", "2026-08-06"],
    completeness_ratio: 0.71,
  });
  assert.equal(result.metrics.sleep_duration.recent.median, 440);
  assert.equal(result.metrics.sleep_duration.comparison.non_diagnostic, true);
});

test("analysis excludes low-coverage heart-rate days and marks the current day partial", () => {
  const heartRate = [
    daily("2026-08-01", { avg_hr: 75, sample_count: 100 }),
    daily("2026-08-02", { avg_hr: 76, sample_count: 100 }),
    daily("2026-08-03", { avg_hr: 77, sample_count: 100 }),
    daily("2026-08-04", { avg_hr: 78, sample_count: 20 }),
    daily("2026-08-05", { avg_hr: 85, sample_count: 100 }),
    daily("2026-08-06", { avg_hr: 86, sample_count: 100 }),
    daily("2026-08-07", { avg_hr: 87, sample_count: 100 }),
    daily("2026-08-08", { avg_hr: 70, sample_count: 10 }),
  ];

  const result = analyzeHealthSeries(
    { steps: [], sleep: [], heart_rate: heartRate },
    {
      currentDate: "2026-08-08",
      days: 8,
      recentDays: 3,
      nowSeconds: Date.parse("2026-08-08T12:30:00Z") / 1000,
    },
  );

  assert.deepEqual(result.current_day.heart_rate, {
    date: "2026-08-08",
    avg_hr: 70,
    sample_count: 10,
    status: "partial",
  });
  assert.deepEqual(result.data_quality.heart_rate, {
    completed_n: 7,
    accepted_n: 6,
    median_sample_count: 100,
    minimum_accepted_sample_count: 50,
    low_sample_dates: ["2026-08-04"],
    unknown_sample_dates: [],
  });
  assert.equal(result.metrics.heart_rate.recent.median, 86);
  assert.equal(result.metrics.heart_rate.baseline.median, 76);
  assert.equal(result.metrics.heart_rate.comparison.status, "above_baseline");
});

test("analysis excludes heart-rate days whose sample coverage is unknown", () => {
  const heartRate = [
    daily("2026-08-01", { avg_hr: 75, sample_count: 100 }),
    daily("2026-08-02", { avg_hr: 76, sample_count: 100 }),
    daily("2026-08-03", { avg_hr: 77, sample_count: 100 }),
    daily("2026-08-04", { avg_hr: 999, sample_count: null }),
    daily("2026-08-05", { avg_hr: 85, sample_count: 100 }),
    daily("2026-08-06", { avg_hr: 86, sample_count: 100 }),
    daily("2026-08-07", { avg_hr: 87, sample_count: 100 }),
  ];

  const result = analyzeHealthSeries(
    { steps: [], sleep: [], heart_rate: heartRate },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.deepEqual(result.data_quality.heart_rate.unknown_sample_dates, ["2026-08-04"]);
  assert.equal(result.data_quality.heart_rate.accepted_n, 6);
  assert.equal(result.metrics.heart_rate.baseline.n, 3);
  assert.equal(result.metrics.heart_rate.baseline.median, 76);
});

test("analysis orders daily records by date before splitting recent and baseline windows", () => {
  const steps = [
    daily("2026-08-05", { steps: 3000 }),
    daily("2026-08-01", { steps: 1000 }),
    daily("2026-08-07", { steps: 3200 }),
    daily("2026-08-02", { steps: 1000 }),
    daily("2026-08-08", { steps: 50 }),
    daily("2026-08-06", { steps: 3100 }),
    daily("2026-08-03", { steps: 1000 }),
    daily("2026-08-04", { steps: 1000 }),
  ];

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.equal(result.metrics.steps.baseline.median, 1000);
  assert.equal(result.metrics.steps.recent.median, 3100);
});

test("analysis ignores records outside the requested date window", () => {
  const steps = [
    daily("2026-07-31", { steps: 999999 }),
    daily("2026-08-01", { steps: 1000 }),
    daily("2026-08-02", { steps: 1000 }),
    daily("2026-08-03", { steps: 1000 }),
    daily("2026-08-04", { steps: 1000 }),
    daily("2026-08-05", { steps: 3000 }),
    daily("2026-08-06", { steps: 3100 }),
    daily("2026-08-07", { steps: 3200 }),
    daily("2026-08-08", { steps: 50 }),
    daily("2026-08-09", { steps: 888888 }),
  ];

  const nowSeconds = Date.parse("2026-08-08T13:00:00Z") / 1000;
  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    { currentDate: "2026-08-08", days: 8, recentDays: 3, nowSeconds },
  );

  assert.equal(result.metrics.steps.baseline.median, 1000);
  assert.equal(result.metrics.steps.recent.median, 3100);
  assert.equal(result.current_day.steps.steps, 50);
  assert.deepEqual(result.data_quality.sync, {
    latest_data_time: Date.parse("2026-08-08T12:00:00Z") / 1000,
    lag_minutes: 60,
  });
});

test("analysis returns insufficient data when a zero baseline has no usable scale", () => {
  const steps = [
    daily("2026-08-01", { steps: 0 }),
    daily("2026-08-02", { steps: 0 }),
    daily("2026-08-03", { steps: 0 }),
    daily("2026-08-04", { steps: 1000 }),
    daily("2026-08-05", { steps: 1100 }),
    daily("2026-08-06", { steps: 1200 }),
    daily("2026-08-07", { steps: 50 }),
  ];

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    { currentDate: "2026-08-07", days: 8, recentDays: 3 },
  );

  assert.equal(result.metrics.steps.comparison.status, "insufficient_data");
  assert.equal(result.metrics.steps.comparison.median_ratio, null);
});

test("analysis compares unrounded medians and MAD values", () => {
  const steps = [
    daily("2026-08-01", { steps: 99.96 }),
    daily("2026-08-02", { steps: 100 }),
    daily("2026-08-03", { steps: 100.04 }),
    daily("2026-08-04", { steps: 100.2 }),
    daily("2026-08-05", { steps: 100.2 }),
    daily("2026-08-06", { steps: 100.2 }),
    daily("2026-08-07", { steps: 1 }),
  ];

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    { currentDate: "2026-08-07", days: 8, recentDays: 3 },
  );

  assert.equal(result.metrics.steps.baseline.mad, 0.04);
  assert.equal(result.metrics.steps.comparison.status, "above_baseline");
  assert.equal(result.metrics.steps.comparison.robust_z, 3.37);
});

test("analysis preserves missing measurements instead of converting them to zero", () => {
  const steps = [
    daily("2026-08-01", { steps: null }),
    daily("2026-08-02", { steps: "" }),
    daily("2026-08-03", { steps: undefined }),
    daily("2026-08-04", { steps: "   " }),
  ];

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.equal(result.metrics.steps.recent.n, 0);
  assert.equal(result.metrics.steps.comparison.status, "insufficient_data");
});

test("analysis rejects structured and non-decimal measurement values", () => {
  for (const value of [[], [123], {}, "0x10", "1e3"]) {
    const result = analyzeHealthSeries(
      {
        steps: [daily("2026-08-01", { steps: value })],
        sleep: [],
        heart_rate: [],
      },
      { currentDate: "2026-08-08", days: 8, recentDays: 3 },
    );

    assert.equal(result.metrics.steps.baseline.n, 0, JSON.stringify(value));
    assert.deepEqual(result.data_quality.missing_measurements.steps, ["2026-08-01"]);
  }
});

test("analysis reports dates whose records lack usable measurements", () => {
  const result = analyzeHealthSeries(
    {
      steps: [daily("2026-08-01", { steps: null })],
      sleep: [daily("2026-08-02", { total_duration: "   " })],
      heart_rate: [daily("2026-08-03", { avg_hr: undefined, sample_count: 100 })],
    },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.deepEqual(result.data_quality.missing_measurements, {
    steps: ["2026-08-01"],
    sleep_duration: ["2026-08-02"],
    heart_rate: ["2026-08-03"],
    distance: ["2026-08-01"],
    calories: ["2026-08-01"],
  });
});

test("analysis treats negative wearable measurements as invalid", () => {
  const result = analyzeHealthSeries(
    {
      steps: [daily("2026-08-01", { steps: -10 })],
      sleep: [daily("2026-08-02", {
        total_duration: -30,
        sleep_deep_duration: 100,
        sleep_light_duration: -100,
      })],
      heart_rate: [daily("2026-08-03", { avg_hr: -70, sample_count: 100 })],
    },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.deepEqual(result.data_quality.missing_measurements, {
    steps: ["2026-08-01"],
    sleep_duration: ["2026-08-02"],
    heart_rate: ["2026-08-03"],
    distance: ["2026-08-01"],
    calories: ["2026-08-01"],
  });
  assert.equal(result.metrics.steps.recent.n, 0);
  assert.equal(result.metrics.sleep_duration.recent.n, 0);
  assert.equal(result.metrics.heart_rate.recent.n, 0);
  assert.equal(result.metrics.distance.recent.n, 0);
  assert.equal(result.metrics.calories.recent.n, 0);
  assert.equal(result.metrics.distance.comparison.status, "insufficient_data");
  assert.equal(result.metrics.calories.comparison.status, "insufficient_data");
  assert.equal(result.data_quality.heart_rate.accepted_n, 0);
  assert.equal(result.data_quality.sleep_stages.available_n, 1);
  assert.equal(result.data_quality.sleep_stages.unavailable_n, 0);
});

test("analysis does not expose invalid current-day measurements", () => {
  const result = analyzeHealthSeries(
    {
      steps: [daily("2026-08-08", { steps: -1 })],
      sleep: [],
      heart_rate: [daily("2026-08-08", { avg_hr: -70, sample_count: -5 })],
    },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.equal(result.current_day.steps, null);
  assert.equal(result.current_day.heart_rate, null);
  assert.deepEqual(result.data_quality.missing_measurements.steps, ["2026-08-08"]);
  assert.deepEqual(result.data_quality.missing_measurements.heart_rate, ["2026-08-08"]);
});

test("analysis does not label an unfinished current activity day as a missing completed day", () => {
  const dates = Array.from({ length: 7 }, (_, index) => `2026-08-0${index + 1}`);
  const steps = dates.map((date) => daily(date, { steps: 1000 }));
  const heartRate = dates.map((date) => daily(date, { avg_hr: 75, sample_count: 100 }));

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: heartRate },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.deepEqual(result.data_quality.missing_dates.steps, []);
  assert.deepEqual(result.data_quality.missing_dates.heart_rate, []);
  assert.equal(result.current_day.steps, null);
  assert.equal(result.current_day.heart_rate, null);
});

test("analysis reports synchronization lag from the newest health record", () => {
  const nowSeconds = Date.parse("2026-08-08T12:00:00Z") / 1000;
  const steps = [daily("2026-08-08", { time: nowSeconds - 7200, steps: 50 })];
  const sleep = [daily("2026-08-08", { time: nowSeconds - 18000, total_duration: 420 })];

  const result = analyzeHealthSeries(
    { steps, sleep, heart_rate: [] },
    { currentDate: "2026-08-08", days: 8, recentDays: 3, nowSeconds },
  );

  assert.deepEqual(result.data_quality.sync, {
    latest_data_time: nowSeconds - 7200,
    lag_minutes: 120,
  });
});

test("current-day activity never changes completed-day statistics", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100_000 }), (currentSteps) => {
      const steps = [
        daily("2026-08-01", { steps: 1000 }),
        daily("2026-08-02", { steps: 1100 }),
        daily("2026-08-03", { steps: 1200 }),
        daily("2026-08-04", { steps: 3000 }),
        daily("2026-08-05", { steps: 3100 }),
        daily("2026-08-06", { steps: 3200 }),
        daily("2026-08-07", { steps: currentSteps }),
      ];
      const result = analyzeHealthSeries(
        { steps, sleep: [], heart_rate: [] },
        { currentDate: "2026-08-07", days: 8, recentDays: 3 },
      );
      assert.equal(result.metrics.steps.baseline.median, 1100);
      assert.equal(result.metrics.steps.recent.median, 3100);
    }),
  );
});

test("analysis analyzes distance and calories with the steps baseline method", () => {
  const steps = [
    daily("2026-08-01", { steps: 1000, distance: 700, calories: 40 }),
    daily("2026-08-02", { steps: 1100, distance: 770, calories: 44 }),
    daily("2026-08-03", { steps: 900, distance: 630, calories: 36 }),
    daily("2026-08-04", { steps: 1000, distance: 700, calories: 40 }),
    daily("2026-08-05", { steps: 3000, distance: 2100, calories: 120 }),
    daily("2026-08-06", { steps: 3200, distance: 2240, calories: 128 }),
    daily("2026-08-07", { steps: 3100, distance: 2170, calories: 124 }),
    daily("2026-08-08", { steps: 50, distance: 35, calories: 2 }),
  ];

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.deepEqual(result.current_day.distance, {
    date: "2026-08-08",
    distance: 35,
    status: "partial",
  });
  assert.deepEqual(result.current_day.calories, {
    date: "2026-08-08",
    calories: 2,
    status: "partial",
  });

  for (const [metric, { recentMedian, baselineMedian, baselineMad }] of [
    ["distance", { recentMedian: 2170, baselineMedian: 700, baselineMad: 35 }],
    ["calories", { recentMedian: 124, baselineMedian: 40, baselineMad: 2 }],
  ]) {
    const summary = result.metrics[metric];
    assert.equal(summary.recent.n, 3, metric);
    assert.equal(summary.recent.median, recentMedian, metric);
    assert.equal(summary.baseline.n, 4, metric);
    assert.equal(summary.baseline.median, baselineMedian, metric);
    assert.equal(summary.baseline.mad, baselineMad, metric);
    assert.equal(summary.baseline.max, metric === "distance" ? 770 : 44, metric);
    assert.equal(summary.comparison.status, "above_baseline", metric);
    assert.equal(summary.comparison.non_diagnostic, true, metric);
  }
});

test("analysis keeps missing, negative, and invalid distance and calories unknown", () => {
  const steps = [
    daily("2026-08-01", { steps: 1000, distance: 700, calories: 40 }),
    daily("2026-08-05", { steps: 1000, distance: null, calories: -5 }),
    daily("2026-08-06", { steps: 1000, distance: "abc", calories: "" }),
    daily("2026-08-07", { steps: 1000, distance: 700, calories: 40 }),
  ];

  const result = analyzeHealthSeries(
    { steps, sleep: [], heart_rate: [] },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.deepEqual(result.data_quality.missing_measurements.distance, [
    "2026-08-05",
    "2026-08-06",
  ]);
  assert.deepEqual(result.data_quality.missing_measurements.calories, [
    "2026-08-05",
    "2026-08-06",
  ]);
  assert.equal(result.metrics.distance.recent.n, 1);
  assert.equal(result.metrics.calories.recent.n, 1);
  assert.equal(result.metrics.distance.recent.median, 700);
  assert.equal(result.metrics.distance.recent.min, 700);
  assert.equal(result.metrics.calories.recent.median, 40);
  assert.equal(result.metrics.calories.recent.min, 40);
  assert.equal(result.metrics.distance.baseline.n, 1);
  assert.equal(result.metrics.distance.baseline.median, 700);
  assert.equal(result.current_day.distance, null);
  assert.equal(result.current_day.calories, null);
});

test("analysis validates date and window options before allocating dates", () => {
  const validSeries = { steps: [], sleep: [], heart_rate: [] };
  const validDate = "2026-08-08";

  assert.throws(
    () => analyzeHealthSeries(validSeries, {
      currentDate: "2026-02-29",
      days: 8,
      recentDays: 3,
    }),
    /currentDate.*YYYY-MM-DD.*calendar date/i,
  );
  assert.throws(
    () => analyzeHealthSeries(validSeries, {
      currentDate: "2026-08-08T00:00:00Z",
      days: 8,
      recentDays: 3,
    }),
    /currentDate.*YYYY-MM-DD.*calendar date/i,
  );
  assert.throws(
    () => analyzeHealthSeries(validSeries, {
      currentDate: validDate,
      days: 7,
      recentDays: 3,
    }),
    /days.*integer.*8.*30/i,
  );
  assert.throws(
    () => analyzeHealthSeries(validSeries, {
      currentDate: validDate,
      days: Number.MAX_SAFE_INTEGER,
      recentDays: 3,
    }),
    /days.*integer.*8.*30/i,
  );
  assert.throws(
    () => analyzeHealthSeries(validSeries, {
      currentDate: validDate,
      days: 8,
      recentDays: 2,
    }),
    /recentDays.*integer.*3.*14/i,
  );
  assert.throws(
    () => analyzeHealthSeries(validSeries, {
      currentDate: validDate,
      days: 8,
      recentDays: 8,
    }),
    /recentDays.*less than days/i,
  );

  const originalFrom = Array.from;
  Array.from = () => {
    throw new Error("date allocation should not be reached");
  };
  try {
    assert.throws(
      () => analyzeHealthSeries(validSeries, {
        currentDate: validDate,
        days: 1_000_000_000,
        recentDays: 3,
      }),
      /days.*integer.*8.*30/i,
    );
  } finally {
    Array.from = originalFrom;
  }
});

test("analysis partitions sparse windows by calendar dates without backfilling", () => {
  const result = analyzeHealthSeries(
    {
      steps: [
        daily("2026-08-01", { steps: 100 }),
        daily("2026-08-02", { steps: 100 }),
        daily("2026-08-03", { steps: 100 }),
        daily("2026-08-04", { steps: 9000 }),
        daily("2026-08-05", { steps: 2000 }),
        daily("2026-08-07", { steps: 3000 }),
      ],
      sleep: [
        daily("2026-08-01", { total_duration: 400 }),
        daily("2026-08-02", { total_duration: 400 }),
        daily("2026-08-03", { total_duration: 400 }),
        daily("2026-08-04", { total_duration: 400 }),
        daily("2026-08-05", { total_duration: 900 }),
        daily("2026-08-07", { total_duration: "" }),
        daily("2026-08-08", { total_duration: 600 }),
      ],
      heart_rate: [
        daily("2026-08-01", { avg_hr: 70, sample_count: 100 }),
        daily("2026-08-02", { avg_hr: 70, sample_count: 100 }),
        daily("2026-08-03", { avg_hr: 70, sample_count: 100 }),
        daily("2026-08-04", { avg_hr: 999, sample_count: 100 }),
        daily("2026-08-05", { avg_hr: 90, sample_count: 100 }),
        daily("2026-08-06", { avg_hr: 60, sample_count: 20 }),
        daily("2026-08-07", { avg_hr: 100, sample_count: 100 }),
      ],
    },
    { currentDate: "2026-08-08", days: 8, recentDays: 3 },
  );

  assert.deepEqual(result.metrics.steps.recent, {
    n: 2,
    mean: 2500,
    median: 2500,
    min: 2000,
    max: 3000,
    q1: 2250,
    q3: 2750,
    mad: 500,
  });
  assert.equal(result.metrics.steps.baseline.n, 4);
  assert.equal(result.metrics.steps.baseline.median, 100);
  assert.equal(result.metrics.sleep_duration.recent.n, 1);
  assert.equal(result.metrics.sleep_duration.recent.median, 600);
  assert.equal(result.metrics.sleep_duration.baseline.n, 5);
  assert.equal(result.metrics.sleep_duration.baseline.median, 400);
  assert.equal(result.metrics.heart_rate.recent.n, 2);
  assert.equal(result.metrics.heart_rate.recent.median, 95);
  assert.equal(result.metrics.heart_rate.baseline.n, 4);
  assert.equal(result.metrics.heart_rate.baseline.median, 70);
  assert.deepEqual(result.data_quality.heart_rate.low_sample_dates, ["2026-08-06"]);
});

test("analysis canonicalizes duplicate daily records deterministically", () => {
  const series = {
    steps: [
      daily("2026-08-01", { steps: 1000 }),
      daily("2026-08-02", { steps: 1100 }),
      daily("2026-08-03", { steps: 1200 }),
      daily("2026-08-04", { steps: 1300 }),
      daily("2026-08-05", { steps: 3000 }),
      daily("2026-08-06", { steps: 3100 }),
      daily("2026-08-07", { steps: 3200 }),
      daily("2026-08-04", { steps: null, time: 9999999999 }),
      daily("2026-08-08", { steps: null, time: 9999999999 }),
      daily("2026-08-08", { steps: 50, time: 1 }),
    ],
    sleep: [
      daily("2026-08-01", { total_duration: 400, sleep_deep_duration: 0 }),
      daily("2026-08-01", { total_duration: 400, sleep_deep_duration: 100 }),
      daily("2026-08-02", { total_duration: 410, sleep_deep_duration: 100 }),
      daily("2026-08-03", { total_duration: 420, sleep_deep_duration: 100 }),
      daily("2026-08-04", { total_duration: 430, sleep_deep_duration: 100 }),
      daily("2026-08-05", { total_duration: 500, sleep_deep_duration: 100 }),
      daily("2026-08-06", { total_duration: 510, sleep_deep_duration: 100 }),
      daily("2026-08-07", { total_duration: 520, sleep_deep_duration: 100 }),
      daily("2026-08-08", { total_duration: 530, sleep_deep_duration: 100 }),
    ],
    heart_rate: [
      daily("2026-08-01", { avg_hr: 70, sample_count: 100 }),
      daily("2026-08-02", { avg_hr: 71, sample_count: 100 }),
      daily("2026-08-03", { avg_hr: 72, sample_count: 100 }),
      daily("2026-08-04", { avg_hr: 999, sample_count: null }),
      daily("2026-08-04", { avg_hr: 73, sample_count: 100 }),
      daily("2026-08-05", { avg_hr: 80, sample_count: 100 }),
      daily("2026-08-06", { avg_hr: 81, sample_count: 100 }),
      daily("2026-08-07", { avg_hr: 82, sample_count: 100 }),
      daily("2026-08-08", { avg_hr: 60, sample_count: 10 }),
    ],
  };
  const options = { currentDate: "2026-08-08", days: 8, recentDays: 3 };
  const first = analyzeHealthSeries(series, options);
  const reversed = analyzeHealthSeries(
    Object.fromEntries(Object.entries(series).map(([key, records]) => [key, [...records].reverse()])),
    options,
  );

  assert.deepEqual(first, reversed);
  assert.equal(first.metrics.steps.baseline.n, 4);
  assert.equal(first.metrics.steps.recent.n, 3);
  assert.equal(first.data_quality.heart_rate.completed_n, 7);
  assert.equal(first.data_quality.heart_rate.accepted_n, 7);
  assert.deepEqual(first.data_quality.heart_rate.unknown_sample_dates, []);
  assert.deepEqual(first.data_quality.sleep_stages.unavailable_dates, []);
  assert.equal(first.current_day.steps.steps, 50);
});
