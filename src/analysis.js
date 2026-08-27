import {
  mean,
  median,
  medianAbsoluteDeviation,
  quantileSorted,
} from "simple-statistics";

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteMeasurement(value) {
  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sleepStageTotal(record) {
  return [
    record?.sleep_deep_duration,
    record?.sleep_light_duration,
    record?.sleep_rem_duration,
  ].reduce((total, value) => total + (finiteMeasurement(value) ?? 0), 0);
}

function stableStringify(value) {
  if (value === undefined) return '"[undefined]"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function canonicalizeDailyRecords(records, key, { sampleKey = null, preferStages = false } = {}) {
  const selected = new Map();
  const rank = (record) => ({
    usable: finiteMeasurement(record?.[key]) !== null ? 1 : 0,
    secondary: sampleKey
      ? ((finiteMeasurement(record?.[sampleKey]) ?? 0) > 0 ? 1 : 0)
      : (preferStages && sleepStageTotal(record) > 0 ? 1 : 0),
    time: finiteMeasurement(record?.time) ?? -1,
    key: stableStringify(record),
  });
  const better = (candidate, current) => {
    const left = rank(candidate);
    const right = rank(current);
    if (left.usable !== right.usable) return left.usable > right.usable;
    if (left.secondary !== right.secondary) return left.secondary > right.secondary;
    if (left.time !== right.time) return left.time > right.time;
    return left.key < right.key;
  };

  for (const record of records) {
    if (!record?.date) continue;
    const current = selected.get(record.date);
    if (!current || better(record, current)) selected.set(record.date, record);
  }
  return [...selected.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function numericValues(records, key) {
  return records
    .map((record) => finiteMeasurement(record?.[key]))
    .filter((value) => value !== null);
}

function summarize(records, key) {
  const values = numericValues(records, key).sort((left, right) => left - right);
  if (values.length === 0) return { n: 0 };
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    min: values[0],
    max: values.at(-1),
    q1: quantileSorted(values, 0.25),
    q3: quantileSorted(values, 0.75),
    mad: medianAbsoluteDeviation(values),
  };
}

function presentSummary(summary) {
  if (summary.n === 0) return summary;
  return {
    n: summary.n,
    mean: round(summary.mean),
    median: round(summary.median),
    min: round(summary.min),
    max: round(summary.max),
    q1: round(summary.q1),
    q3: round(summary.q3),
    mad: round(summary.mad, 2),
  };
}

function compare(recent, baseline) {
  if (recent.n < 3 || baseline.n < 3) {
    return { status: "insufficient_data", non_diagnostic: true };
  }
  const delta = recent.median - baseline.median;
  const scale = baseline.mad > 0 ? 1.4826 * baseline.mad : null;
  const robustZ = scale ? delta / scale : null;
  const ratio = baseline.median !== 0 ? recent.median / baseline.median : null;
  if (robustZ === null && ratio === null) {
    return {
      status: "insufficient_data",
      median_delta: round(delta),
      median_ratio: null,
      robust_z: null,
      non_diagnostic: true,
    };
  }
  let status = "within_baseline";
  if ((robustZ !== null && robustZ >= 2.5) || (robustZ === null && ratio >= 1.25)) {
    status = "above_baseline";
  } else if ((robustZ !== null && robustZ <= -2.5) || (robustZ === null && ratio <= 0.75)) {
    status = "below_baseline";
  }
  return {
    status,
    median_delta: round(delta),
    median_ratio: round(ratio, 2),
    robust_z: round(robustZ, 2),
    non_diagnostic: true,
  };
}

function analyzeMetric(records, key, recentDates, baselineDates) {
  const recentDateSet = new Set(recentDates);
  const baselineDateSet = new Set(baselineDates);
  const recent = summarize(
    records.filter((record) => recentDateSet.has(record?.date)),
    key,
  );
  const baseline = summarize(
    records.filter((record) => baselineDateSet.has(record?.date)),
    key,
  );
  return {
    recent: presentSummary(recent),
    baseline: presentSummary(baseline),
    comparison: compare(recent, baseline),
  };
}

function isUtcCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validateOptions(options) {
  const currentDate = options?.currentDate;
  const days = options?.days === undefined ? 30 : options.days;
  const recentDays = options?.recentDays === undefined ? 7 : options.recentDays;
  if (!isUtcCalendarDate(currentDate)) {
    throw new TypeError("currentDate must be a real YYYY-MM-DD UTC calendar date");
  }
  if (!Number.isInteger(days) || days < 8 || days > 30) {
    throw new RangeError("days must be an integer from 8 through 30");
  }
  if (!Number.isInteger(recentDays) || recentDays < 3 || recentDays > 14) {
    throw new RangeError("recentDays must be an integer from 3 through 14");
  }
  if (recentDays >= days) {
    throw new RangeError("recentDays must be less than days");
  }
  return { currentDate, days, recentDays };
}

function expectedDates(currentDate, days) {
  const end = Date.parse(`${currentDate}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  return Array.from({ length: days }, (_, index) =>
    new Date(end - (days - index - 1) * 86400 * 1000).toISOString().slice(0, 10));
}

function missingDates(records, dates) {
  const present = new Set(records.map((record) => record?.date).filter(Boolean));
  return dates.filter((date) => !present.has(date));
}

function missingMeasurementDates(records, key) {
  return [...new Set(
    records
      .filter((record) => record?.date && finiteMeasurement(record?.[key]) === null)
      .map((record) => record.date),
  )].sort();
}

function sleepStageQuality(records) {
  const unavailableDates = [];
  let available = 0;
  for (const record of records) {
    const stageTotal = sleepStageTotal(record);
    if (stageTotal > 0) available += 1;
    else if ((finiteMeasurement(record?.total_duration) ?? 0) > 0 && record?.date) {
      unavailableDates.push(record.date);
    }
  }
  const total = available + unavailableDates.length;
  return {
    available_n: available,
    unavailable_n: unavailableDates.length,
    unavailable_dates: [...new Set(unavailableDates)].sort(),
    completeness_ratio: total > 0 ? round(available / total, 2) : null,
  };
}

function heartRateQuality(records) {
  const coverage = records.map((record) => ({
    record,
    sampleCount: finiteMeasurement(record?.sample_count),
  }));
  const known = coverage.filter(({ sampleCount }) => sampleCount !== null && sampleCount > 0);
  const counts = known.map(({ sampleCount }) => sampleCount);
  const medianSampleCount = counts.length > 0 ? median(counts) : null;
  const minimumAccepted = medianSampleCount === null ? null : medianSampleCount * 0.5;
  const low = minimumAccepted === null
    ? []
    : known.filter(({ sampleCount }) => sampleCount < minimumAccepted);
  const unknown = coverage.filter(({ sampleCount }) => sampleCount === null || sampleCount <= 0);
  const accepted = known
    .filter(({ sampleCount }) => minimumAccepted === null || sampleCount >= minimumAccepted)
    .filter(({ record }) => finiteMeasurement(record?.avg_hr) !== null)
    .map(({ record }) => record);
  return {
    quality: {
      completed_n: records.length,
      accepted_n: accepted.length,
      median_sample_count: medianSampleCount === null ? null : round(medianSampleCount),
      minimum_accepted_sample_count: minimumAccepted === null ? null : round(minimumAccepted),
      low_sample_dates: [...new Set(low.map(({ record }) => record.date).filter(Boolean))].sort(),
      unknown_sample_dates: [
        ...new Set(unknown.map(({ record }) => record.date).filter(Boolean)),
      ].sort(),
    },
    accepted,
  };
}

function synchronizationQuality(series, nowSeconds) {
  const timestamps = Object.values(series)
    .flatMap((records) => Array.isArray(records) ? records : [])
    .flatMap((record) => [record?.time, record?.wake_up_time, record?.latest_hr?.time])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : null;
  return {
    latest_data_time: latest,
    lag_minutes:
      latest !== null && Number.isFinite(nowSeconds)
        ? round(Math.max(0, nowSeconds - latest) / 60)
        : null,
  };
}

export function analyzeHealthSeries(series, options) {
  const { currentDate, recentDays, days } = validateOptions(options);
  const dates = expectedDates(currentDate, days);
  const requestedDates = new Set(dates);
  const inWindow = (records) =>
    (Array.isArray(records) ? records : []).filter((record) => requestedDates.has(record?.date));
  const rawSteps = inWindow(series?.steps);
  const rawSleep = inWindow(series?.sleep);
  const rawHeartRate = inWindow(series?.heart_rate);
  const steps = canonicalizeDailyRecords(rawSteps, "steps");
  const sleep = canonicalizeDailyRecords(rawSleep, "total_duration", { preferStages: true });
  const heartRate = canonicalizeDailyRecords(rawHeartRate, "avg_hr", {
    sampleKey: "sample_count",
  });
  const currentSteps = steps.find((record) => record.date === currentDate);
  const currentHeartRate = heartRate.find((record) => record.date === currentDate);
  const currentStepsValue = finiteMeasurement(currentSteps?.steps);
  const currentHeartRateValue = finiteMeasurement(currentHeartRate?.avg_hr);
  const currentHeartSampleCount = finiteMeasurement(currentHeartRate?.sample_count);
  const completedSteps = steps.filter((record) => record.date !== currentDate);
  const completedHeartRate = heartRate.filter((record) => record.date !== currentDate);
  const heartQuality = heartRateQuality(completedHeartRate);
  const completedActivityDates = dates.filter((date) => date !== currentDate);
  const recentActivityDates = completedActivityDates.slice(-recentDays);
  const baselineActivityDates = completedActivityDates.slice(0, -recentDays);
  const recentSleepDates = dates.slice(-recentDays);
  const baselineSleepDates = dates.slice(0, -recentDays);

  return {
    current_day: {
      steps: currentStepsValue !== null
        ? { date: currentSteps.date, steps: currentStepsValue, status: "partial" }
        : null,
      heart_rate: currentHeartRateValue !== null
        ? {
            date: currentHeartRate.date,
            avg_hr: currentHeartRateValue,
            sample_count:
              currentHeartSampleCount !== null && currentHeartSampleCount > 0
                ? currentHeartSampleCount
                : null,
            status: "partial",
          }
        : null,
    },
    data_quality: {
      missing_dates: {
        steps: missingDates(completedSteps, completedActivityDates),
        sleep: missingDates(sleep, dates),
        heart_rate: missingDates(completedHeartRate, completedActivityDates),
      },
      missing_measurements: {
        steps: missingMeasurementDates(steps, "steps"),
        sleep_duration: missingMeasurementDates(sleep, "total_duration"),
        heart_rate: missingMeasurementDates(heartRate, "avg_hr"),
      },
      sleep_stages: sleepStageQuality(sleep),
      heart_rate: heartQuality.quality,
      sync: synchronizationQuality(
        { steps: rawSteps, sleep: rawSleep, heart_rate: rawHeartRate },
        options.nowSeconds,
      ),
    },
    metrics: {
      steps: analyzeMetric(
        completedSteps,
        "steps",
        recentActivityDates,
        baselineActivityDates,
      ),
      sleep_duration: analyzeMetric(
        sleep,
        "total_duration",
        recentSleepDates,
        baselineSleepDates,
      ),
      heart_rate: analyzeMetric(
        heartQuality.accepted,
        "avg_hr",
        recentActivityDates,
        baselineActivityDates,
      ),
    },
  };
}
