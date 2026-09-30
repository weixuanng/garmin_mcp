// Pure ports of the upstream Python curation logic. Each function names the
// Python source it mirrors so upstream changes can be carried over line by line.

export type Json = Record<string, any>;

/** Python truthiness: None, {}, [], "", 0 and False are all falsy. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Python round(x, n): decided on the float's exact decimal value, ties to even.
 * So round(14.25, 1) is 14.2 and round(0.15, 1) is 0.1 (0.15 is really 0.1499…),
 * where Math.round would give 14.3 and 0.2.
 */
export function round(value: number, digits = 0): number {
  // Beyond 1e15 there are no fractional digits left to round (and toFixed
  // switches to exponent notation at 1e21).
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) return value;
  // toFixed prints the exact binary value; 60 extra digits settle any tie.
  const [whole, fraction = ""] = Math.abs(value).toFixed(Math.min(100, digits + 60)).split(".");
  let kept = BigInt(whole + fraction.slice(0, digits));
  const rest = fraction.slice(digits);
  const half = "5".padEnd(rest.length, "0");
  if (rest > half || (rest === half && kept % 2n === 1n)) kept += 1n;
  return (Math.sign(value) * Number(kept)) / 10 ** digits;
}

/** Drop None values, like `{k: v for k, v in d.items() if v is not None}`. */
export function dropNone<T extends Json>(obj: T): T {
  const out: Json = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Python json.dumps(x, indent=2). */
export function dumps(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

// --- health_wellness.py: _extract_sleep_summary ------------------------------

export function extractSleepSummary(sleepData: Json): Json {
  const summary: Json = {};

  const dailySleep = sleepData.dailySleepDTO;
  if (truthy(dailySleep)) {
    summary.sleep_seconds = dailySleep.sleepTimeSeconds;
    summary.nap_seconds = dailySleep.napTimeSeconds;
    summary.sleep_start = dailySleep.sleepStartTimestampGMT;
    summary.sleep_end = dailySleep.sleepEndTimestampGMT;

    const sleepScores = asObject(dailySleep.sleepScores);
    const overallScore = asObject(sleepScores.overall);
    summary.sleep_score = overallScore.value;
    summary.sleep_score_qualifier = overallScore.qualifierKey;

    summary.deep_sleep_seconds = dailySleep.deepSleepSeconds;
    summary.light_sleep_seconds = dailySleep.lightSleepSeconds;
    summary.rem_sleep_seconds = dailySleep.remSleepSeconds;
    summary.awake_seconds = dailySleep.awakeSleepSeconds;

    summary.awake_count = dailySleep.awakeCount;
    summary.restless_moments_count = dailySleep.restlessMomentsCount;

    summary.avg_sleep_stress = dailySleep.avgSleepStress;
    summary.resting_heart_rate_bpm = dailySleep.restingHeartRate;
  }

  const spo2Summary = sleepData.wellnessSpO2SleepSummaryDTO;
  if (truthy(spo2Summary)) {
    summary.avg_spo2_percent = spo2Summary.averageSpo2;
    summary.lowest_spo2_percent = spo2Summary.lowestSpo2;
  }

  if ("avgOvernightHrv" in sleepData) {
    summary.avg_overnight_hrv = sleepData.avgOvernightHrv;
  }

  // Skip unmeasured phases instead of reporting them as 0%.
  const totalSleep = summary.sleep_seconds;
  if (truthy(totalSleep) && totalSleep > 0) {
    for (const [phaseKey, percentKey] of [
      ["deep_sleep_seconds", "deep_sleep_percent"],
      ["light_sleep_seconds", "light_sleep_percent"],
      ["rem_sleep_seconds", "rem_sleep_percent"],
    ]) {
      const phaseSeconds = summary[phaseKey];
      if (phaseSeconds !== null && phaseSeconds !== undefined) {
        summary[percentKey] = round((phaseSeconds / totalSleep) * 100, 1);
      }
    }
  }

  if (truthy(totalSleep)) {
    summary.sleep_hours = round(totalSleep / 3600, 2);
  }

  return dropNone(summary);
}

// --- health_wellness.py: get_training_readiness --------------------------------

export function curateTrainingReadiness(readinessList: Json[]): Json[] {
  return readinessList.map((r) =>
    dropNone({
      date: r.calendarDate,
      timestamp: r.timestampLocal,
      context: r.inputContext,

      level: r.level,
      score: r.score,
      feedback: r.feedbackShort,

      sleep_score: r.sleepScore,
      sleep_factor_percent: r.sleepScoreFactorPercent,
      sleep_factor_feedback: r.sleepScoreFactorFeedback,

      recovery_time_hours: truthy(r.recoveryTime) ? round(r.recoveryTime / 60, 1) : null,
      recovery_factor_percent: r.recoveryTimeFactorPercent,
      recovery_factor_feedback: r.recoveryTimeFactorFeedback,

      training_load_factor_percent: r.acwrFactorPercent,
      training_load_feedback: r.acwrFactorFeedback,
      acute_load: r.acuteLoad,

      hrv_factor_percent: r.hrvFactorPercent,
      hrv_factor_feedback: r.hrvFactorFeedback,
      hrv_weekly_avg: r.hrvWeeklyAverage,

      stress_history_factor_percent: r.stressHistoryFactorPercent,
      stress_history_feedback: r.stressHistoryFactorFeedback,

      sleep_history_factor_percent: r.sleepHistoryFactorPercent,
      sleep_history_feedback: r.sleepHistoryFactorFeedback,
    }),
  );
}

// --- garminconnect: Garmin.get_morning_training_readiness ---------------------

export function pickMorningReadiness(data: unknown): Json | null {
  if (!truthy(data)) return null;
  if (Array.isArray(data)) {
    const morning = data.find((entry) => asObject(entry).inputContext === "AFTER_WAKEUP_RESET");
    if (morning === undefined && data.length > 0) return asObject(data[0]);
    return morning ?? null;
  }
  return asObject(data);
}

// --- health_wellness.py: get_morning_training_readiness -----------------------

export function curateMorningReadiness(readiness: Json, date: string): Json {
  return dropNone({
    date,
    readiness_score: readiness.readinessScore,
    readiness_level: readiness.readinessLevel,
    recovery_time_hours:
      readiness.recoveryTime !== null && readiness.recoveryTime !== undefined
        ? round((readiness.recoveryTime ?? 0) / 60, 1)
        : null,
    hrv_status: readiness.hrvStatus,
    sleep_quality: readiness.sleepQuality,
    sleep_score: readiness.sleepScore,
    resting_heart_rate_bpm: readiness.restingHeartRate,
    hrv_baseline: readiness.hrvBaseline,
    hrv_last_night: readiness.hrvLastNight,
    body_battery_percent: readiness.bodyBattery,
    stress_level: readiness.stressLevel,
    training_load_balance: readiness.trainingLoadBalance,
    acute_load: readiness.acuteLoad,
    chronic_load: readiness.chronicLoad,
  });
}

// --- health_wellness.py: get_body_battery ---------------------------------------

export function curateBodyBattery(batteryData: Json[]): Json[] {
  return batteryData.map((day) => {
    const entry: Json = {
      date: day.date,
      charged: day.charged,
      drained: day.drained,
      events: [] as Json[],
    };
    for (const event of (day.bodyBatteryActivityEvent as Json[] | null) ?? []) {
      entry.events.push({
        type: event.eventType,
        start_time: event.eventStartTimeGmt,
        duration_minutes: round((event.durationInMilliseconds ?? 0) / 60000, 1),
        body_battery_impact: event.bodyBatteryImpact,
        feedback: event.shortFeedback,
      });
    }
    const feedback = day.bodyBatteryDynamicFeedbackEvent;
    if (truthy(feedback)) {
      entry.current_feedback = feedback.feedbackShortType;
      entry.body_battery_level = feedback.bodyBatteryLevel;
    }
    return entry;
  });
}

// --- health_wellness.py: get_heart_rates_summary --------------------------------

export function summarizeHeartRates(hrData: Json): Json {
  const summary: Json = {
    date: hrData.calendarDate,
    max_heart_rate_bpm: hrData.maxHeartRate,
    min_heart_rate_bpm: hrData.minHeartRate,
    resting_heart_rate_bpm: hrData.restingHeartRate,
    last_7_days_avg_resting_hr: hrData.lastSevenDaysAvgRestingHeartRate,
  };
  const hrValues = (hrData.heartRateValues as any[] | null) ?? [];
  if (hrValues.length) {
    const valid = hrValues.map((v) => v?.[1]).filter((v) => truthy(v) && v > 0) as number[];
    if (valid.length) {
      summary.avg_heart_rate_bpm = round(valid.reduce((a, b) => a + b, 0) / valid.length, 1);
      summary.data_points_count = valid.length;
    }
  }
  return dropNone(summary);
}

// --- health_wellness.py: get_stress_summary -------------------------------------

export function summarizeStress(stressData: Json): Json {
  const summary: Json = {
    date: stressData.calendarDate,
    max_stress_level: stressData.maxStressLevel,
    avg_stress_level: stressData.avgStressLevel,
  };
  const stressValues = (stressData.stressValuesArray as any[] | null) ?? [];
  if (stressValues.length) {
    // Exclude -1 and -2, which mark gaps and activity.
    const valid = stressValues.map((v) => v?.[1]).filter((v) => truthy(v) && v > 0) as number[];
    const total = valid.length || 1;
    const share = (count: number) => round((count / total) * 100, 1);
    summary.rest_percent = share(valid.filter((v) => v < 26).length);
    summary.low_stress_percent = share(valid.filter((v) => v >= 26 && v < 51).length);
    summary.medium_stress_percent = share(valid.filter((v) => v >= 51 && v < 76).length);
    summary.high_stress_percent = share(valid.filter((v) => v >= 76).length);
    summary.data_points_count = valid.length;
  }
  return dropNone(summary);
}

// --- health_wellness.py: get_respiration_summary --------------------------------

export function summarizeRespiration(respData: Json): Json {
  return dropNone({
    date: respData.calendarDate,
    lowest_breaths_per_min: respData.lowestRespirationValue,
    highest_breaths_per_min: respData.highestRespirationValue,
    avg_waking_breaths_per_min: respData.avgWakingRespirationValue,
    avg_sleep_breaths_per_min: respData.avgSleepRespirationValue,
  });
}

// --- health_wellness.py: get_spo2_data ------------------------------------------

export function curateSpo2(spo2Data: Json): Json {
  const summary: Json = {
    date: spo2Data.calendarDate,
    avg_spo2_percent: spo2Data.averageSpO2,
    lowest_spo2_percent: spo2Data.lowestSpO2,
    latest_spo2_percent: spo2Data.latestSpO2,
    latest_reading_time: spo2Data.latestSpO2TimestampLocal,
    last_7_days_avg_spo2: spo2Data.lastSevenDaysAvgSpO2,
    avg_sleep_spo2_percent: spo2Data.avgSleepSpO2,
  };
  const hourly = spo2Data.spO2HourlyAverages;
  if (truthy(hourly)) summary.hourly_averages = hourly;
  return dropNone(summary);
}

// --- training.py: get_hrv_data ----------------------------------------------------

export function curateHrv(hrvData: Json, date: string, returnTimeseries: boolean): Json {
  const summary = asObject(hrvData.hrvSummary);
  const baseline = asObject(summary.baseline);
  const curated: Json = {
    date: summary.calendarDate || date,
    last_night_avg_hrv_ms: summary.lastNightAvg,
    last_night_5min_high_hrv_ms: summary.lastNight5MinHigh,
    weekly_avg_hrv_ms: summary.weeklyAvg,
    baseline_balanced_low_ms: baseline.balancedLow,
    baseline_balanced_upper_ms: baseline.balancedUpper,
    baseline_low_upper_ms: baseline.lowUpper,
    status: summary.status,
    feedback: summary.feedbackPhrase,
    sleep_start: hrvData.sleepStartTimestampLocal,
    sleep_end: hrvData.sleepEndTimestampLocal,
  };
  if (returnTimeseries) {
    const readings = (hrvData.hrvReadings as Json[] | null) ?? [];
    curated.hrv_readings = readings.map((r) => ({ time: r.readingTimeLocal, hrv_ms: r.hrvValue }));
    curated.readings_count = readings.length;
  }
  return dropNone(curated);
}

// --- training.py: get_hrv_trend (per-day entry) ---------------------------------

export function hrvTrendEntry(data: Json, date: string): Json {
  const hrvSummary = asObject(data.hrvSummary);
  const entry: Json = { date };
  if (isNumber(hrvSummary.lastNightAvg)) entry.last_night_avg_hrv_ms = round(hrvSummary.lastNightAvg, 1);
  if (isNumber(hrvSummary.weeklyAvg)) entry.weekly_avg_hrv_ms = round(hrvSummary.weeklyAvg, 1);
  if (isNumber(hrvSummary.lastNight5MinHigh)) entry.last_night_5min_high_hrv_ms = round(hrvSummary.lastNight5MinHigh, 1);
  if (truthy(hrvSummary.status)) entry.status = hrvSummary.status;
  if (truthy(hrvSummary.feedbackPhrase)) entry.feedback = hrvSummary.feedbackPhrase;
  return entry;
}

// --- training.py: get_respiration_trend (per-day entry) -------------------------

export function respirationTrendEntry(data: Json, date: string): Json {
  const entry: Json = { date };
  if (isNumber(data.avgWakingRespirationValue)) entry.avg_waking_breaths_per_min = round(data.avgWakingRespirationValue, 1);
  if (isNumber(data.avgSleepRespirationValue)) entry.avg_sleep_breaths_per_min = round(data.avgSleepRespirationValue, 1);
  if (isNumber(data.highestRespirationValue)) entry.highest_breaths_per_min = round(data.highestRespirationValue, 1);
  if (isNumber(data.lowestRespirationValue)) entry.lowest_breaths_per_min = round(data.lowestRespirationValue, 1);
  return entry;
}

export function average(values: number[]): number | null {
  return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 1) : null;
}

// --- health_wellness.py: recovery-time helpers ------------------------------------

export function recoveryState(remainingHours: number | null, phrase: unknown): string {
  if (phrase === "REACHED_ZERO" || remainingHours === 0) return "recovered";
  if (remainingHours === null) return "unknown";
  if (remainingHours <= 6) return "nearly_recovered";
  if (remainingHours <= 24) return "recovering";
  return "not_recovered";
}

export function hoursFromRecoveryMinutes(minutes: unknown, phrase: unknown = null): number | null {
  // Garmin keeps the last assigned minutes after the clock has drained to zero.
  if (phrase === "REACHED_ZERO") return 0;
  if (!isNumber(minutes) || minutes < 0) return null;
  return round(minutes / 60, 1);
}

function asSnapshotList(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (payload && typeof payload === "object") return [payload as Json];
  return [];
}

export function recoveryFromReadiness(payload: unknown, source: string): Json | null {
  const snapshots = asSnapshotList(payload);
  if (!snapshots.length) return null;
  const stamp = (item: Json) => String(item.timestampLocal || item.timestamp || "");
  const latest = snapshots.reduce((best, item) => (stamp(item) > stamp(best) ? item : best));
  const phrase = latest.recoveryTimeChangePhrase;
  const hours = hoursFromRecoveryMinutes(latest.recoveryTime, phrase);
  if (hours === null) return null;
  const score = latest.score ?? latest.readinessScore;
  return dropNone({
    remaining_hours: hours,
    recovery_score: score,
    state: recoveryState(hours, phrase),
    source,
    date: latest.calendarDate,
    timestamp: latest.timestampLocal || latest.timestamp,
    change_phrase: phrase,
    level: latest.level || latest.readinessLevel,
  });
}

function activityEndUtc(activity: Json): number | null {
  const begin = activity.beginTimestamp;
  const duration = Number(activity.duration || activity.elapsedDuration || 0);
  const durationS = Number.isFinite(duration) ? duration : 0;
  if (isNumber(begin) && begin > 0) return begin + durationS * 1000;
  return null;
}

export function recoveryFromRecentActivities(items: unknown, nowMs: number): Json | null {
  if (!Array.isArray(items)) return null;
  let best: Json | null = null;
  let bestEnd: number | null = null;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const recovery = item.recoveryTime;
    if (!isNumber(recovery)) continue;
    const end = activityEndUtc(item);
    if (end === null) continue;
    const elapsedMin = Math.max(0, (nowMs - end) / 60000);
    const remainingHours = round(Math.max(0, recovery - elapsedMin) / 60, 1);
    if (bestEnd === null || end > bestEnd) {
      bestEnd = end;
      best = {
        remaining_hours: remainingHours,
        recovery_score: null,
        state: recoveryState(remainingHours, null),
        source: "recent_activity",
        activity_id: item.activityId,
        activity_name: item.activityName,
      };
    }
  }
  return best ? dropNone(best) : null;
}

export const RECOVERY_UNAVAILABLE_MESSAGE =
  "No recovery time remaining found for this date. Training Readiness " +
  "snapshots were empty and recent activities did not include recoveryTime. " +
  "Some devices (for example Forerunner 255) show recovery on-device without " +
  "publishing a Connect Training Readiness feed.";

// --- date helpers -----------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse YYYY-MM-DD strictly; returns a UTC-midnight timestamp or null. */
export function parseDate(value: string): number | null {
  if (!DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

/** Every date from start to end inclusive, as YYYY-MM-DD. */
export function dateRange(startMs: number, endMs: number): string[] {
  const days: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) days.push(new Date(ms).toISOString().slice(0, 10));
  return days;
}

/** Today's date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
