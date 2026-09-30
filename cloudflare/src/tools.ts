// Sleep and recovery tools ported from upstream garmin_mcp (health_wellness.py
// and training.py). Names, descriptions and output shapes match upstream so
// the same prompts work locally and online.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  RECOVERY_UNAVAILABLE_MESSAGE,
  average,
  curateBodyBattery,
  curateHrv,
  curateMorningReadiness,
  curateSpo2,
  curateTrainingReadiness,
  dateRange,
  dumps,
  extractSleepSummary,
  hrvTrendEntry,
  parseDate,
  pickMorningReadiness,
  recoveryFromReadiness,
  recoveryFromRecentActivities,
  respirationTrendEntry,
  summarizeHeartRates,
  summarizeRespiration,
  summarizeStress,
  todayIn,
  truthy,
  type Json,
} from "./curate";
import { GarminAuthError, type GarminClient } from "./garmin";

export interface ToolOptions {
  timeZone: string;
  /** Free-plan Workers allow 50 outbound requests per call, so ranges are capped. */
  maxRangeDays: number;
  /**
   * Nights per get_sleep_summary_range call. Each night's payload is large and
   * parsing it counts against the free plan's 10 ms CPU budget.
   */
  maxSleepNights: number;
  /** Appended to Garmin sign-in errors: how to paste a fresh token. */
  setupHint: string;
}

// Parallel Garmin requests per tool call (Workers allow 6 open connections).
const CONCURRENCY = 5;

const dateArg = z.string().describe("Date in YYYY-MM-DD format");
const startArg = z.string().describe("Start date in YYYY-MM-DD format");
const endArg = z.string().describe("End date in YYYY-MM-DD format");
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function asList(value: unknown): Json[] {
  if (Array.isArray(value)) return value;
  return truthy(value) ? [value as Json] : [];
}

export function registerTools(server: McpServer, client: GarminClient, options: ToolOptions): void {
  const describe = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GarminAuthError && !message.includes("/setup")) return `${message} ${options.setupHint}`;
    return message;
  };

  /** Run a tool body, turning failures into upstream-style "Error retrieving ..." text. */
  const guarded = (what: string, body: () => Promise<string>) => async () => {
    try {
      return text(await body());
    } catch (error) {
      return text(`Error retrieving ${what}: ${describe(error)}`);
    }
  };

  const requireDate = (date: string) => {
    if (parseDate(date) === null) throw new Error(`Invalid date '${date}'. Use YYYY-MM-DD.`);
  };

  /** Validate a range the way upstream does, with this deployment's cap. */
  const rangeDays = (startDate: string, endDate: string, upstreamMax: number, cap = options.maxRangeDays): string[] | string => {
    const start = parseDate(startDate);
    const end = parseDate(endDate);
    if (start === null || end === null) {
      return `Invalid date format: expected YYYY-MM-DD, got '${start === null ? startDate : endDate}'. Use YYYY-MM-DD.`;
    }
    const days = Math.round((end - start) / 86_400_000) + 1;
    const max = Math.min(upstreamMax, cap);
    if (days > max) {
      return `Date range too large (${days} days). Maximum is ${max} days. Split it into several calls of up to ${max} days.`;
    }
    if (days < 1) return "end_date must be on or after start_date.";
    return dateRange(start, end);
  };

  /** Fetch one payload per day; skip days that fail, but surface sign-in problems. */
  const perDay = async (dates: string[], fetchDay: (date: string) => Promise<any>) => {
    await client.displayName(); // fail fast if Garmin isn't connected
    return mapPool(dates, CONCURRENCY, async (date) => {
      try {
        return { date, data: await fetchDay(date) };
      } catch (error) {
        if (error instanceof GarminAuthError) throw error;
        return { date, data: null };
      }
    });
  };

  // --- sleep ------------------------------------------------------------------

  server.registerTool(
    "get_sleep_summary",
    {
      title: "Sleep summary",
      description:
        "Get sleep summary with only essential metrics (lightweight version)\n\n" +
        "This endpoint returns a compact summary of sleep data (~350 bytes) instead of the full " +
        "granular data (~50KB). Ideal for daily health checkups and LLM integrations where the " +
        "full time-series data would overwhelm the context window.",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("sleep summary", async () => {
        requireDate(date);
        const sleepData = await client.getSleepData(date);
        if (!truthy(sleepData)) return `No sleep summary found for ${date}`;
        return dumps(extractSleepSummary(sleepData));
      })(),
  );

  server.registerTool(
    "get_sleep_summary_range",
    {
      title: "Sleep summaries for a date range",
      description:
        "Get lightweight sleep summaries for every night in a date range.\n\n" +
        "Returns the same curated metrics as get_sleep_summary (sleep score, duration, sleep stages, " +
        "HRV, resting HR, etc.) for each night between start_date and end_date, inclusive. Use this " +
        "instead of calling get_sleep_summary once per night when analyzing sleep trends.\n\n" +
        `Garmin has no range endpoint for sleep, so this makes one request per night. Maximum: ` +
        `${Math.min(90, options.maxSleepNights)} nights per call; split longer periods into several calls.`,
      inputSchema: { start_date: startArg, end_date: endArg },
      annotations: readOnly,
    },
    async ({ start_date, end_date }) => {
      const dates = rangeDays(start_date, end_date, 90, options.maxSleepNights);
      if (typeof dates === "string") return text(dates);
      return guarded("sleep data", async () => {
        const days = await perDay(dates, (date) => client.getSleepData(date));
        const nights: Json[] = [];
        for (const { date, data } of days) {
          if (!truthy(data)) continue;
          const entry = { date, ...extractSleepSummary(data) };
          if (Object.keys(entry).length > 1) nights.push(entry);
        }
        if (!nights.length) return `No sleep data found between ${start_date} and ${end_date}.`;
        return dumps({
          start_date,
          end_date,
          nights_requested: dates.length,
          nights_returned: nights.length,
          nights,
        });
      })();
    },
  );

  server.registerTool(
    "get_sleep_data",
    {
      title: "Full sleep data",
      description:
        "Get full sleep data with all details\n\n" +
        "Note: This returns detailed sleep data (~50KB). For a compact summary, use get_sleep_summary().",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("sleep data", async () => {
        requireDate(date);
        const sleepData = await client.getSleepData(date);
        if (!truthy(sleepData)) return `No sleep data found for ${date}`;
        return dumps(sleepData);
      })(),
  );

  // --- HRV ----------------------------------------------------------------------

  server.registerTool(
    "get_hrv_data",
    {
      title: "HRV",
      description: "Get Heart Rate Variability (HRV) data",
      inputSchema: {
        date: dateArg,
        return_timeseries: z
          .boolean()
          .default(false)
          .describe("If True, include detailed 5-minute HRV readings (can be large)"),
      },
      annotations: readOnly,
    },
    ({ date, return_timeseries }) =>
      guarded("HRV data", async () => {
        requireDate(date);
        const hrvData = await client.getHrvData(date);
        if (!truthy(hrvData)) return `No HRV data found for ${date}.`;
        return dumps(curateHrv(hrvData, date, return_timeseries));
      })(),
  );

  server.registerTool(
    "get_hrv_trend",
    {
      title: "HRV trend",
      description:
        "Get HRV (Heart Rate Variability) trend over a date range.\n\n" +
        "Returns daily HRV values and weekly rolling averages. Single-day HRV is too noisy to act " +
        "on — use this tool to identify baseline shifts that signal accumulated fatigue or recovery. " +
        "A drop of >10ms from the 7-day baseline warrants reducing training load.\n\n" +
        `Recommended range: 7-21 days. Maximum: ${Math.min(30, options.maxRangeDays)} days.`,
      inputSchema: { start_date: startArg, end_date: endArg },
      annotations: readOnly,
    },
    async ({ start_date, end_date }) => {
      const dates = rangeDays(start_date, end_date, 30);
      if (typeof dates === "string") return text(dates);
      return guarded("HRV trend", async () => {
        const days = await perDay(dates, (date) => client.getHrvData(date));
        const trend = days
          .filter(({ data }) => truthy(data))
          .map(({ date, data }) => hrvTrendEntry(data, date))
          .filter((entry) => Object.keys(entry).length > 1);
        if (!trend.length) return `No HRV data found between ${start_date} and ${end_date}.`;
        const values = trend.map((e) => e.last_night_avg_hrv_ms).filter((v) => v !== undefined);
        return dumps({
          start_date,
          end_date,
          days_with_data: trend.length,
          period_avg_hrv_ms: average(values),
          trend,
        });
      })();
    },
  );

  // --- body battery ------------------------------------------------------------

  server.registerTool(
    "get_body_battery",
    {
      title: "Body Battery",
      description: "Get body battery data with events",
      inputSchema: { start_date: startArg, end_date: endArg },
      annotations: readOnly,
    },
    ({ start_date, end_date }) =>
      guarded("body battery data", async () => {
        requireDate(start_date);
        requireDate(end_date);
        const batteryData = await client.getBodyBattery(start_date, end_date);
        if (!truthy(batteryData)) return `No body battery data found between ${start_date} and ${end_date}`;
        return dumps(curateBodyBattery(asList(batteryData)));
      })(),
  );

  server.registerTool(
    "get_body_battery_events",
    {
      title: "Body Battery events",
      description: "Get body battery events data",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("body battery events", async () => {
        requireDate(date);
        const events = await client.getBodyBatteryEvents(date);
        if (!truthy(events)) return `No body battery events found for ${date}`;
        return dumps(events);
      })(),
  );

  // --- readiness and recovery -------------------------------------------------

  server.registerTool(
    "get_training_readiness",
    {
      title: "Training readiness",
      description:
        "Get training readiness data with curated metrics\n\n" +
        "Returns training readiness score and contributing factors.",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("training readiness data", async () => {
        requireDate(date);
        const readinessList = await client.getTrainingReadiness(date);
        if (!truthy(readinessList)) return `No training readiness data found for ${date}`;
        return dumps(curateTrainingReadiness(asList(readinessList)));
      })(),
  );

  server.registerTool(
    "get_morning_training_readiness",
    {
      title: "Morning training readiness",
      description:
        "Get morning training readiness score\n\n" +
        "Returns the morning training readiness assessment, which evaluates recovery status and " +
        "readiness to train based on overnight metrics.",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("morning training readiness", async () => {
        requireDate(date);
        const readiness = pickMorningReadiness(await client.getTrainingReadiness(date));
        if (!truthy(readiness)) return `No morning training readiness data found for ${date}`;
        return dumps(curateMorningReadiness(readiness!, date));
      })(),
  );

  server.registerTool(
    "get_recovery_time_remaining",
    {
      title: "Recovery time remaining",
      description:
        "Get remaining recovery time in hours for a day.\n\n" +
        "This is the Firstbeat recovery clock shown on-device, distinct from Training Readiness " +
        "score (missing on some devices such as Forerunner 255) and from Training Status ACWR. " +
        "When Training Readiness snapshots exist they are the current remaining value. Otherwise " +
        "the tool decays recoveryTime assigned on recent activities.",
      inputSchema: {
        date: z.string().default("").describe("Date in YYYY-MM-DD format. Defaults to today."),
      },
      annotations: readOnly,
    },
    async ({ date }) => {
      const day = date.trim() || todayIn(options.timeZone);
      if (parseDate(day) === null) return text(`Invalid date '${day}'. Use YYYY-MM-DD.`);
      return guarded("recovery time remaining", async () => {
        await client.displayName(); // surface sign-in problems instead of "unavailable"
        const safe = async (fn: () => Promise<any>) => {
          try {
            return await fn();
          } catch (error) {
            if (error instanceof GarminAuthError) throw error;
            return null;
          }
        };
        const readiness = await safe(() => client.getTrainingReadiness(day));
        let curated = recoveryFromReadiness(readiness, "training_readiness");
        if (!curated) {
          curated = recoveryFromReadiness(pickMorningReadiness(readiness), "morning_training_readiness");
        }
        if (!curated) {
          curated = recoveryFromRecentActivities(await safe(() => client.getActivities(0, 20)), Date.now());
        }
        if (curated) {
          if (!("date" in curated)) curated.date = day;
          return dumps(curated);
        }
        return dumps({
          remaining_hours: null,
          recovery_score: null,
          state: "unavailable",
          date: day,
          message: RECOVERY_UNAVAILABLE_MESSAGE,
        });
      })();
    },
  );

  // --- heart rate, stress, respiration, SpO2 ---------------------------------

  server.registerTool(
    "get_rhr_day",
    {
      title: "Resting heart rate",
      description: "Get resting heart rate data",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("resting heart rate data", async () => {
        requireDate(date);
        const rhrData = await client.getRhrDay(date);
        if (!truthy(rhrData)) return `No resting heart rate data found for ${date}`;
        return dumps(rhrData);
      })(),
  );

  server.registerTool(
    "get_heart_rates_summary",
    {
      title: "Heart rate summary",
      description:
        "Get heart rate summary with essential metrics (lightweight version)\n\n" +
        "Returns a compact summary (~500 bytes) instead of full time-series data (~25KB). " +
        "Ideal for daily health checkups and LLM integrations.",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("heart rate summary", async () => {
        requireDate(date);
        const hrData = await client.getHeartRates(date);
        if (!truthy(hrData)) return `No heart rate data found for ${date}`;
        return dumps(summarizeHeartRates(hrData));
      })(),
  );

  server.registerTool(
    "get_stress_summary",
    {
      title: "Stress summary",
      description:
        "Get stress summary with essential metrics (lightweight version)\n\n" +
        "Returns a compact summary (~400 bytes) instead of full time-series data (~35KB). " +
        "Ideal for daily health checkups and LLM integrations.",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("stress summary", async () => {
        requireDate(date);
        const stressData = await client.getStressData(date);
        if (!truthy(stressData)) return `No stress data found for ${date}`;
        return dumps(summarizeStress(stressData));
      })(),
  );

  server.registerTool(
    "get_respiration_summary",
    {
      title: "Respiration summary",
      description:
        "Get respiration summary with essential metrics (lightweight version)\n\n" +
        "Returns a compact summary (~300 bytes) instead of full time-series data (~20KB).",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("respiration summary", async () => {
        requireDate(date);
        const respData = await client.getRespirationData(date);
        if (!truthy(respData)) return `No respiration data found for ${date}`;
        return dumps(summarizeRespiration(respData));
      })(),
  );

  server.registerTool(
    "get_respiration_trend",
    {
      title: "Respiration trend",
      description:
        "Get overnight respiration rate trend over a date range.\n\n" +
        "Elevated resting respiration rate (compared to personal baseline) is an early warning sign " +
        "for overreaching, illness, or poor recovery. Use this alongside HRV trend for a complete " +
        "recovery picture.\n\n" +
        `Recommended range: 7-21 days. Maximum: ${Math.min(30, options.maxRangeDays)} days.`,
      inputSchema: { start_date: startArg, end_date: endArg },
      annotations: readOnly,
    },
    async ({ start_date, end_date }) => {
      const dates = rangeDays(start_date, end_date, 30);
      if (typeof dates === "string") return text(dates);
      return guarded("respiration trend", async () => {
        const days = await perDay(dates, (date) => client.getRespirationData(date));
        const trend = days
          .filter(({ data }) => truthy(data))
          .map(({ date, data }) => respirationTrendEntry(data, date))
          .filter((entry) => Object.keys(entry).length > 1);
        if (!trend.length) return `No respiration data found between ${start_date} and ${end_date}.`;
        const sleepValues = trend
          .map((e) => e.avg_sleep_breaths_per_min)
          .filter((v) => v !== undefined);
        return dumps({
          start_date,
          end_date,
          days_with_data: trend.length,
          period_avg_sleep_breaths_per_min: average(sleepValues),
          trend,
        });
      })();
    },
  );

  server.registerTool(
    "get_spo2_data",
    {
      title: "SpO2",
      description: "Get SpO2 (blood oxygen) data",
      inputSchema: { date: dateArg },
      annotations: readOnly,
    },
    ({ date }) =>
      guarded("SpO2 data", async () => {
        requireDate(date);
        const spo2Data = await client.getSpo2Data(date);
        if (!truthy(spo2Data)) return `No SpO2 data found for ${date}`;
        return dumps(curateSpo2(spo2Data));
      })(),
  );
}

export const TOOL_NAMES = [
  "get_sleep_summary",
  "get_sleep_summary_range",
  "get_sleep_data",
  "get_hrv_data",
  "get_hrv_trend",
  "get_body_battery",
  "get_body_battery_events",
  "get_training_readiness",
  "get_morning_training_readiness",
  "get_recovery_time_remaining",
  "get_rhr_day",
  "get_heart_rates_summary",
  "get_stress_summary",
  "get_respiration_summary",
  "get_respiration_trend",
  "get_spo2_data",
] as const;
