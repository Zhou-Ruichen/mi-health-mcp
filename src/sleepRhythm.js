import { median, medianAbsoluteDeviation } from "simple-statistics";

import { isUtcCalendarDate } from "./analysis.js";

const MINUTES_PER_DAY = 1440;
const TWO_PI = Math.PI * 2;
const EPSILON = 1e-9;
const RECENT_DAYS = 7;
const MIN_GROUP_RECORDS = 3;
const MAX_DURATION_MINUTES = 960;
const MIN_DURATION_MINUTES = 60;
const HIGH_SPREAD_MINUTES = 120;

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function shiftDate(date, deltaDays) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + deltaDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
}

function minuteOfDay(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
    : null;
}

function isWeekend(date) {
  const day = new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
  return day === 0 || day === 6;
}

function angleOf(minutes) {
  return (minutes / MINUTES_PER_DAY) * TWO_PI;
}

function shortArcMinutes(from, to) {
  const forward = (((to - from) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return Math.min(forward, MINUTES_PER_DAY - forward);
}

function signedArcMinutes(from, to) {
  const forward = (((to - from) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return forward > MINUTES_PER_DAY / 2 ? forward - MINUTES_PER_DAY : forward;
}

function formatClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// 环形中位数：候选点为各观测角及其对径点，取到全部观测弧距离中位数最小者；
// 并列时依次用平均弧距、并列候选方向的圆均值收敛到确定值。
function circularMedian(minutesList) {
  const angles = minutesList.map(angleOf);
  const candidates = [...angles, ...angles.map((angle) => (angle + Math.PI) % TWO_PI)];
  const scored = candidates.map((candidate) => {
    const distances = angles.map((angle) =>
      Math.min(Math.abs(angle - candidate), TWO_PI - Math.abs(angle - candidate)));
    return {
      angle: candidate,
      medianDistance: median(distances),
      meanDistance: distances.reduce((total, value) => total + value, 0) / distances.length,
    };
  });
  const bestMedianDistance = Math.min(...scored.map((item) => item.medianDistance));
  const finalists = scored.filter((item) => item.medianDistance <= bestMedianDistance + EPSILON);
  const bestMeanDistance = Math.min(...finalists.map((item) => item.meanDistance));
  const tied = finalists.filter((item) => item.meanDistance <= bestMeanDistance + EPSILON);
  let x = 0;
  let y = 0;
  for (const item of tied) {
    x += Math.cos(item.angle);
    y += Math.sin(item.angle);
  }
  const direction = Math.atan2(y, x);
  const minutes = ((Math.round((direction / TWO_PI) * MINUTES_PER_DAY) % MINUTES_PER_DAY) +
    MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return {
    minutes,
    madMinutes: (bestMedianDistance / TWO_PI) * MINUTES_PER_DAY,
  };
}

function clockStats(minutesList) {
  if (minutesList.length === 0) return null;
  const { minutes, madMinutes } = circularMedian(minutesList);
  return {
    median: formatClock(minutes),
    median_minutes: minutes,
    mad_minutes: round(madMinutes),
  };
}

function durationStats(minutesList) {
  if (minutesList.length === 0) return null;
  return {
    median_minutes: Math.round(median(minutesList)),
    mad_minutes: round(medianAbsoluteDeviation(minutesList)),
  };
}

function groupStats(records) {
  return {
    records: records.length,
    bedtime: clockStats(records.map((record) => record.bedtime)),
    wake_up_time: clockStats(records.map((record) => record.wakeUp)),
    duration: durationStats(records.map((record) => record.duration)),
  };
}

function validateSleepOptions(options) {
  const currentDate = options?.currentDate;
  const days = options?.days === undefined ? 14 : options.days;
  if (!isUtcCalendarDate(currentDate)) {
    throw new TypeError("currentDate must be a real YYYY-MM-DD UTC calendar date");
  }
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new RangeError("days must be an integer from 1 through 30");
  }
  return { currentDate, days };
}

export function analyzeSleepRhythm(records, options) {
  const { currentDate, days } = validateSleepOptions(options);
  const windowDates = [];
  for (let offset = -(days - 1); offset <= 0; offset += 1) {
    windowDates.push(shiftDate(currentDate, offset));
  }
  const windowSet = new Set(windowDates);

  const valid = [];
  let napsExcluded = 0;
  let suspiciousRecords = 0;
  let invalidRecords = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record.date !== "string" || !windowSet.has(record.date)) continue;
    if (record.is_nap === true) {
      napsExcluded += 1;
      continue;
    }
    const bedtime = minuteOfDay(record.bedtime);
    const wakeUp = minuteOfDay(record.wake_up_time);
    const duration = typeof record.total_duration === "number" &&
        Number.isFinite(record.total_duration) && record.total_duration > 0
      ? record.total_duration
      : null;
    if (bedtime === null || wakeUp === null || duration === null) {
      invalidRecords += 1;
      continue;
    }
    if (duration > MAX_DURATION_MINUTES || duration < MIN_DURATION_MINUTES) {
      suspiciousRecords += 1;
      continue;
    }
    valid.push({ date: record.date, bedtime, wakeUp, duration });
  }

  const validDates = new Set(valid.map((record) => record.date));
  const missingDates = windowDates.filter((date) => !validDates.has(date));
  const dataQuality = {
    valid_records: valid.length,
    missing_days: missingDates.length,
    missing_dates: missingDates,
    naps_excluded: napsExcluded,
    suspicious_records: suspiciousRecords,
    invalid_records: invalidRecords,
  };

  if (valid.length === 0) {
    return {
      data_quality: dataQuality,
      schedule: { bedtime: null, wake_up_time: null, duration: null },
      social_jetlag_minutes: null,
      weekday_vs_weekend: { weekday: null, weekend: null },
      recent_shift: null,
      limitations: ["窗口内没有有效睡眠记录；缺失日期不计为 0，不会由更早记录补位。"],
      non_diagnostic: true,
    };
  }

  const bedtimes = valid.map((record) => record.bedtime);
  const wakeUps = valid.map((record) => record.wakeUp);
  const bedtimeStats = circularMedian(bedtimes);
  const wakeUpStats = circularMedian(wakeUps);
  const schedule = {
    bedtime: clockStats(bedtimes),
    wake_up_time: clockStats(wakeUps),
    duration: durationStats(valid.map((record) => record.duration)),
  };

  const bedtimeByDate = new Map(valid.map((record) => [record.date, record.bedtime]));
  const jetlagPairs = [];
  for (let index = 1; index < windowDates.length; index += 1) {
    const previous = bedtimeByDate.get(windowDates[index - 1]);
    const current = bedtimeByDate.get(windowDates[index]);
    if (previous !== undefined && current !== undefined) {
      jetlagPairs.push(shortArcMinutes(previous, current));
    }
  }
  const socialJetlagMinutes = jetlagPairs.length > 0 ? round(median(jetlagPairs)) : null;

  const limitations = [];
  if (socialJetlagMinutes === null) {
    limitations.push("缺少相邻两天的入睡记录，未计算入睡偏移（social jetlag）。");
  }

  const weekdayRecords = valid.filter((record) => !isWeekend(record.date));
  const weekendRecords = valid.filter((record) => isWeekend(record.date));
  const weekdayStats = weekdayRecords.length >= MIN_GROUP_RECORDS
    ? groupStats(weekdayRecords)
    : null;
  const weekendStats = weekendRecords.length >= MIN_GROUP_RECORDS
    ? groupStats(weekendRecords)
    : null;
  if (weekdayStats === null || weekendStats === null) {
    limitations.push(
      `工作日或周末的有效记录不足 ${MIN_GROUP_RECORDS} 条（工作日 ${weekdayRecords.length} 条，` +
      `周末 ${weekendRecords.length} 条），分组比较不完整。`,
    );
  }

  const recentStart = shiftDate(currentDate, -(RECENT_DAYS - 1));
  const recentRecords = valid.filter((record) => record.date >= recentStart);
  const baselineRecords = valid.filter((record) => record.date < recentStart);
  let recentShift = null;
  if (recentRecords.length >= MIN_GROUP_RECORDS && baselineRecords.length >= MIN_GROUP_RECORDS) {
    const recentDurationMedian = median(recentRecords.map((record) => record.duration));
    const baselineDurationMedian = median(baselineRecords.map((record) => record.duration));
    recentShift = {
      recent: groupStats(recentRecords),
      baseline: groupStats(baselineRecords),
      bedtime_shift_minutes: round(signedArcMinutes(
        circularMedian(baselineRecords.map((record) => record.bedtime)).minutes,
        circularMedian(recentRecords.map((record) => record.bedtime)).minutes,
      )),
      wake_shift_minutes: round(signedArcMinutes(
        circularMedian(baselineRecords.map((record) => record.wakeUp)).minutes,
        circularMedian(recentRecords.map((record) => record.wakeUp)).minutes,
      )),
      duration_shift_minutes: Math.round(recentDurationMedian - baselineDurationMedian),
    };
  } else {
    limitations.push(
      `最近 ${RECENT_DAYS} 天或基线的有效记录不足 ${MIN_GROUP_RECORDS} 条，未计算近期偏移。`,
    );
  }

  if (missingDates.length > 0) {
    limitations.push(
      `${missingDates.length} 天无有效主睡眠记录；缺失日期不计为 0，不会由更早记录补位。`,
    );
  }
  if (suspiciousRecords > 0) {
    limitations.push(
      `${suspiciousRecords} 条记录的时长超过 16 小时或少于 1 小时，已排除在统计之外。`,
    );
  }
  if (invalidRecords > 0) {
    limitations.push(`${invalidRecords} 条记录缺少入睡、起床或时长字段，无法使用。`);
  }
  if (bedtimeStats.madMinutes > HIGH_SPREAD_MINUTES ||
    wakeUpStats.madMinutes > HIGH_SPREAD_MINUTES) {
    limitations.push(
      `入睡或起床时间的环形 MAD 超过 ${HIGH_SPREAD_MINUTES} 分钟，作息离散度过大，` +
      "结果仅作参考，不下硬性结论。",
    );
  }
  limitations.push(
    "入睡和起床时刻按时间戳的钟表时刻解释，未做时区或夏令时校正；跨时区旅行会扭曲环形统计。",
  );

  return {
    data_quality: dataQuality,
    schedule,
    social_jetlag_minutes: socialJetlagMinutes,
    weekday_vs_weekend: { weekday: weekdayStats, weekend: weekendStats },
    recent_shift: recentShift,
    limitations,
    non_diagnostic: true,
  };
}
