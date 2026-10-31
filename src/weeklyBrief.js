import { analyzeHealthSeries, isUtcCalendarDate } from "./analysis.js";
import { analyzeSleepRhythm } from "./sleepRhythm.js";
import { analyzeWorkoutSessions } from "./workoutAnalysis.js";

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// direction 用"高于/低于/持平基线"这类可核实的表述；数值证据放 evidence。
function directionLabel(status) {
  if (status === "above_baseline") return "高于基线";
  if (status === "below_baseline") return "低于基线";
  if (status === "within_baseline") return "与基线持平";
  return null;
}

function buildObservation(metric, metricResult) {
  const comparison = metricResult?.comparison;
  if (!comparison || comparison.status === "insufficient_data" || comparison.status === "within_baseline") {
    return null;
  }
  const z = comparison.robust_z;
  const zText = z !== null && z !== undefined
    ? `robust z=${round(z, 1)}`
    : `比值 ${round(comparison.median_ratio, 2)}`;
  return {
    metric,
    direction: directionLabel(comparison.status),
    evidence: `近期中位数 ${metricResult.recent.median} vs 基线中位数 ${metricResult.baseline.median}（${zText}）`,
  };
}

function toRhythmRecords(sleepRecords) {
  return (Array.isArray(sleepRecords) ? sleepRecords : []).map((record) => ({
    date: record.date,
    bedtime: typeof record.bedtime === "number" ? record.bedtime / 60 : undefined,
    wake_up_time: typeof record.wake_up_time === "number" ? record.wake_up_time / 60 : undefined,
    total_duration: record.total_duration,
    is_nap: record.is_nap === true,
  }));
}

export function buildWeeklyBrief(series, options) {
  const currentDate = options?.currentDate;
  const days = options?.days === undefined ? 28 : options.days;
  const recentDays = options?.recentDays === undefined ? 7 : options.recentDays;
  const includeWorkouts = options?.includeWorkouts !== false;
  if (!isUtcCalendarDate(currentDate)) {
    throw new TypeError("currentDate must be a real YYYY-MM-DD UTC calendar date");
  }
  if (!Number.isInteger(days) || days < 8 || days > 42) {
    throw new RangeError("days must be an integer from 8 through 42");
  }
  if (!Number.isInteger(recentDays) || recentDays < 1 || recentDays > 14) {
    throw new RangeError("recentDays must be an integer from 1 through 14");
  }
  if (recentDays >= days) {
    throw new RangeError("recentDays must be less than days");
  }
  const nowSeconds = options?.nowSeconds;
  const minRecords = Math.min(3, recentDays);

  // 三个指标共用一次 analyzeHealthSeries 基线比较，睡眠钟点复用 sleepRhythm 的环形统计。
  const analysis = analyzeHealthSeries(series, {
    currentDate,
    days,
    recentDays,
    nowSeconds,
    maxDays: 42,
  });
  const rhythm = analyzeSleepRhythm(toRhythmRecords(series?.sleep), {
    currentDate,
    days,
    maxDays: 42,
  });

  const observations = [];
  const limitations = [];
  const evidence = {};
  const dataQuality = {};
  const summary = {};

  for (const [metric, key, missingKey] of [
    ["sleep", "sleep_duration", "sleep"],
    ["heart_rate", "heart_rate", "heart_rate"],
    ["steps", "steps", "steps"],
  ]) {
    const metricResult = analysis.metrics[key];
    const recentN = metricResult.recent.n ?? 0;
    const baselineN = metricResult.baseline.n ?? 0;
    evidence[metric] = {
      recent: { median: recentN > 0 ? metricResult.recent.median : null, n: recentN },
      baseline: { median: baselineN > 0 ? metricResult.baseline.median : null, n: baselineN },
      robust_z: metricResult.comparison?.robust_z ?? null,
    };
    dataQuality[metric] = {
      valid_days: recentN + baselineN,
      recent_n: recentN,
      baseline_n: baselineN,
      missing_dates: analysis.data_quality.missing_dates[missingKey],
      sync_lag_minutes: analysis.data_quality.sync.lag_minutes,
    };
    if (metricResult.comparison?.status === "insufficient_data" || recentN < minRecords) {
      limitations.push(
        `${metric} 有效数据不足（近期 ${recentN} 天，基线 ${baselineN} 天），不给出趋势结论。`,
      );
    } else {
      const observation = buildObservation(metric, metricResult);
      if (observation) observations.push(observation);
    }
    summary[metric] = {
      recent_median: recentN > 0 ? metricResult.recent.median : null,
      baseline_median: baselineN > 0 ? metricResult.baseline.median : null,
      status: metricResult.comparison?.status ?? null,
      valid_days: recentN + baselineN,
    };
  }

  if (includeWorkouts) {
    const workoutAnalysis = analyzeWorkoutSessions(series?.workouts, {
      currentDate,
      days,
      recentDays,
      nowSeconds,
      maxDays: 42,
    });
    const statuses = [
      workoutAnalysis.comparison.session_count,
      workoutAnalysis.comparison.active_days,
      workoutAnalysis.comparison.duration,
    ];
    if (statuses.every((value) => value === "insufficient_data")) {
      limitations.push("运动记录不足，无法与基线窗口比较。");
    } else if (statuses.some((value) => value !== "within_baseline")) {
      const direction = statuses.every((value) => value === "above_baseline")
        ? "高于基线"
        : statuses.every((value) => value === "below_baseline")
        ? "低于基线"
        : "与基线互有高低";
      observations.push({
        metric: "workouts",
        direction,
        evidence:
          `近 ${recentDays} 天 ${workoutAnalysis.recent.session_count} 次 session、` +
          `${workoutAnalysis.recent.active_days} 个活跃日、` +
          `${workoutAnalysis.recent.total_duration_seconds} 秒，` +
          `基线窗口中位数 ${workoutAnalysis.baseline.median_session_count} 次 / ` +
          `${workoutAnalysis.baseline.median_active_days} 天 / ` +
          `${workoutAnalysis.baseline.median_duration_seconds} 秒`,
      });
    }
    summary.workouts = {
      session_count: workoutAnalysis.recent.session_count,
      active_days: workoutAnalysis.recent.active_days,
      total_duration_seconds: workoutAnalysis.recent.total_duration_seconds,
      comparison: {
        session_count: workoutAnalysis.comparison.session_count,
        active_days: workoutAnalysis.comparison.active_days,
        duration: workoutAnalysis.comparison.duration,
      },
      days_since_last_workout: workoutAnalysis.recent.days_since_last_workout,
    };
    dataQuality.workouts = {
      session_count: workoutAnalysis.data_quality.session_count,
      sync_lag_hours: workoutAnalysis.data_quality.sync.lag_hours,
    };
    evidence.workouts = {
      recent: {
        session_count: workoutAnalysis.recent.session_count,
        active_days: workoutAnalysis.recent.active_days,
        total_duration_seconds: workoutAnalysis.recent.total_duration_seconds,
      },
      baseline: {
        median_session_count: workoutAnalysis.baseline.median_session_count,
        median_active_days: workoutAnalysis.baseline.median_active_days,
        median_duration_seconds: workoutAnalysis.baseline.median_duration_seconds,
        complete_windows: workoutAnalysis.baseline.complete_windows,
      },
    };
  }

  const clockShift = rhythm.recent_shift;
  if (clockShift) {
    for (const [label, shiftKey, recentKey, metricKey] of [
      ["入睡", "bedtime_shift_minutes", "bedtime", "bedtime_clock"],
      ["起床", "wake_shift_minutes", "wake_up_time", "wake_clock"],
    ]) {
      const minutes = clockShift[shiftKey];
      const recentStat = clockShift.recent?.[recentKey];
      if (minutes === null || minutes === undefined || recentStat === null) continue;
      observations.push({
        metric: metricKey,
        direction: minutes > 0
          ? `近 7 天${label}钟点晚于基线`
          : minutes < 0
          ? `近 7 天${label}钟点早于基线`
          : `近 7 天${label}钟点与基线持平`,
        evidence:
          `近 7 天${label}钟点中位数 ${recentStat.median}，` +
          `相对基线偏移 ${minutes} 分钟（环形统计）`,
      });
    }
  } else {
    limitations.push(
      "睡眠钟点数据不足（近 7 天或基线的有效主睡眠记录少于 3 天），未计算入睡/起床钟点偏移。",
    );
  }

  if (rhythm.data_quality.naps_excluded > 0) {
    limitations.push(`${rhythm.data_quality.naps_excluded} 条小睡记录不计入睡眠钟点统计。`);
  }
  const syncLagMinutes = analysis.data_quality.sync.lag_minutes;
  if (syncLagMinutes !== null && syncLagMinutes > 6 * 60) {
    limitations.push(`数据同步延迟 ${syncLagMinutes} 分钟，最新数据可能不完整。`);
  }
  limitations.push(
    "全部比较基于个人历史窗口中位数，只描述可核实的同期变化，不做因果推断，不推断疾病，不输出恢复评分。",
  );

  return {
    period: { current_date: currentDate, days, recent_days: recentDays },
    summary,
    observations,
    evidence,
    data_quality: dataQuality,
    limitations,
    non_diagnostic: true,
  };
}
