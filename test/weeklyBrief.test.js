import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS, ToolValidationError, callTool } from "../src/tools.js";
import { buildWeeklyBrief } from "../src/weeklyBrief.js";

const CURRENT_DATE = "2026-08-28";

function daily(offsetDay, values) {
  const date = new Date(Date.parse(`${CURRENT_DATE}T00:00:00Z`) - offsetDay * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { date, time: Date.parse(`${date}T12:00:00Z`) / 1000, ...values };
}

// 近 7 天步数明显高于基线，睡眠与心率持平。
function fullFixture() {
  const steps = [];
  const sleep = [];
  const heartRate = [];
  for (let offset = 27; offset >= 7; offset -= 1) {
    steps.push(daily(offset, { steps: 1000 + offset }));
    sleep.push(daily(offset, {
      total_duration: 420,
      bedtime: Date.parse(`${daily(offset, {}).date}T23:30:00Z`) / 1000,
      wake_up_time: Date.parse(`${daily(offset, {}).date}T07:00:00Z`) / 1000,
    }));
    heartRate.push(daily(offset, { avg_hr: 70, sample_count: 100 }));
  }
  for (let offset = 6; offset >= 0; offset -= 1) {
    steps.push(daily(offset, { steps: 3000 + offset }));
    sleep.push(daily(offset, {
      total_duration: 420,
      bedtime: Date.parse(`${daily(offset, {}).date}T23:30:00Z`) / 1000,
      wake_up_time: Date.parse(`${daily(offset, {}).date}T07:00:00Z`) / 1000,
    }));
    heartRate.push(daily(offset, { avg_hr: 70, sample_count: 100 }));
  }
  const workouts = [
    daily(20, { start_time: Date.parse(`${daily(20, {}).date}T10:00:00Z`) / 1000, duration_seconds: 1800, sport_type: "walk" }),
    daily(13, { start_time: Date.parse(`${daily(13, {}).date}T10:00:00Z`) / 1000, duration_seconds: 1800, sport_type: "walk" }),
    daily(6, { start_time: Date.parse(`${daily(6, {}).date}T10:00:00Z`) / 1000, duration_seconds: 1800, sport_type: "walk" }),
    daily(2, { start_time: Date.parse(`${daily(2, {}).date}T10:00:00Z`) / 1000, duration_seconds: 3600, sport_type: "run", distance: 5000, calories: 300, avg_hr: 140, max_hr: 160 }),
  ];
  return { steps, sleep, heart_rate: heartRate, workouts };
}

const OPTIONS = {
  currentDate: CURRENT_DATE,
  days: 28,
  recentDays: 7,
  nowSeconds: Date.parse(`${CURRENT_DATE}T12:00:00Z`) / 1000,
};

test("weekly brief returns complete fields with hand-checkable values", () => {
  const brief = buildWeeklyBrief(fullFixture(), OPTIONS);

  assert.deepEqual(brief.period, { current_date: CURRENT_DATE, days: 28, recent_days: 7 });

  // 步数：近期窗口为 offsets 7..1（中位数 3003），基线窗口为 offsets 27..8（1008..1027，中位数 1017.5）。
  const stepsEvidence = brief.evidence.steps;
  assert.equal(stepsEvidence.recent.n, 7);
  assert.equal(stepsEvidence.recent.median, 3003);
  assert.equal(stepsEvidence.baseline.n, 20);
  assert.equal(stepsEvidence.baseline.median, 1017.5);

  // 睡眠：近 7 天与基线中位数都是 420。
  assert.equal(brief.evidence.sleep.recent.median, 420);
  assert.equal(brief.evidence.sleep.baseline.median, 420);
  assert.equal(brief.summary.sleep.status, "within_baseline");

  // 心率：近 7 天与基线中位数都是 70，MAD 为 0，比较 status within_baseline。
  assert.equal(brief.evidence.heart_rate.recent.median, 70);
  assert.equal(brief.summary.heart_rate.status, "within_baseline");

  // 步数 observation：数值证据可核实。
  const stepsObservation = brief.observations.find((item) => item.metric === "steps");
  assert.ok(stepsObservation, "steps observation expected");
  assert.equal(stepsObservation.direction, "高于基线");
  assert.match(stepsObservation.evidence, /robust z=/);

  // 与基线持平的指标不进入 observations，只在 summary 里给 status。
  assert.ok(!brief.observations.some((item) => item.metric === "sleep"));
  assert.ok(!brief.observations.some((item) => item.metric === "heart_rate"));

  // 汇总字段齐全。
  for (const metric of ["sleep", "heart_rate", "steps", "workouts"]) {
    assert.ok(brief.summary[metric], `summary.${metric} expected`);
  }
  assert.equal(brief.summary.workouts.session_count, 2);
  assert.equal(brief.summary.workouts.active_days, 2);
  assert.equal(brief.summary.workouts.total_duration_seconds, 5400);

  // 睡眠钟点两行：23:30 入睡、07:00 起床，偏移 0。
  const bedtimeObservation = brief.observations.find((item) => item.metric === "bedtime_clock");
  const wakeObservation = brief.observations.find((item) => item.metric === "wake_clock");
  assert.ok(bedtimeObservation, "bedtime_clock observation expected");
  assert.ok(wakeObservation, "wake_clock observation expected");
  assert.match(bedtimeObservation.evidence, /23:30/);
  assert.match(wakeObservation.evidence, /07:00/);

  // 数据质量与限制说明。
  assert.equal(brief.data_quality.steps.recent_n, 7);
  assert.ok(Array.isArray(brief.limitations));
  assert.ok(brief.limitations.some((line) => line.includes("不做因果推断")));
  assert.equal(brief.non_diagnostic, true);
});

test("weekly brief skips workout analysis when include_workouts is false", () => {
  const brief = buildWeeklyBrief(fullFixture(), {
    ...OPTIONS,
    includeWorkouts: false,
  });

  assert.equal(brief.summary.workouts, undefined);
  assert.equal(brief.evidence.workouts, undefined);
  assert.equal(brief.data_quality.workouts, undefined);
  assert.ok(!brief.observations.some((item) => item.metric === "workouts"));
});

test("weekly brief reports sparse metrics in limitations without observations", () => {
  const fixture = fullFixture();
  // 只保留近 7 天里的 2 天步数和全部运动。
  fixture.steps = fixture.steps.filter((record) => record.date >= "2026-08-27");
  const brief = buildWeeklyBrief(fixture, OPTIONS);

  assert.ok(
    brief.limitations.some((line) => line.startsWith("steps")),
    `limitations should mention steps: ${JSON.stringify(brief.limitations)}`,
  );
  assert.ok(!brief.observations.some((item) => item.metric === "steps"));
});

test("weekly brief observations avoid causal wording", () => {
  const brief = buildWeeklyBrief(fullFixture(), OPTIONS);
  const text = JSON.stringify(brief.observations);
  assert.doesNotMatch(text, /因为|导致|引起|改善|恢复评分/);
  for (const observation of brief.observations) {
    assert.equal(typeof observation.metric, "string");
    assert.equal(typeof observation.direction, "string");
    assert.equal(typeof observation.evidence, "string");
  }
});

test("weekly brief tool is listed and validates arguments", async () => {
  assert.ok(TOOLS.some((tool) => tool.name === "health_weekly_brief"));

  await assert.rejects(
    callTool("health_weekly_brief", { days: 8, recent_days: 8 }, {}, fetch),
    (error) => error instanceof ToolValidationError && /recent_days 必须小于 days/.test(error.message),
  );
  await assert.rejects(
    callTool("health_weekly_brief", { days: 43 }, {}, fetch),
    ToolValidationError,
  );
  await assert.rejects(
    callTool("health_weekly_brief", { include_workouts: "yes" }, {}, fetch),
    ToolValidationError,
  );
});

test("weekly brief validates window options", () => {
  assert.throws(
    () => buildWeeklyBrief(fullFixture(), { ...OPTIONS, recentDays: 14, days: 14 }),
    /recentDays must be less than days/,
  );
  assert.throws(
    () => buildWeeklyBrief(fullFixture(), { ...OPTIONS, days: 7 }),
    /days must be an integer from 8 through 42/,
  );
  assert.throws(
    () => buildWeeklyBrief(fullFixture(), { ...OPTIONS, days: 43 }),
    /days must be an integer from 8 through 42/,
  );
  assert.throws(
    () => buildWeeklyBrief(fullFixture(), { ...OPTIONS, recentDays: 0 }),
    /recentDays must be an integer from 1 through 14/,
  );
});
