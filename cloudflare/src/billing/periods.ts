export type BillingTime = "calendar" | "anniversary";

export type LocalDate = {
  year: number;
  month: number;
  day: number;
};

export type ProrationWindow = {
  billableDays: number;
  fullPeriodDays: number;
};

const LOCAL_PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export function assertBillingTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized) throw new Error("invalid_billing_timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
  } catch {
    throw new Error("invalid_billing_timezone");
  }
  return normalized;
}

export function firstPeriodEnd(
  start: Date,
  interval: string,
  billingTime: BillingTime,
  timezone: string,
): Date {
  if (billingTime === "anniversary") return nextPeriodEnd(start, interval);
  const local = localDate(start, timezone);
  const boundary = nextCalendarBoundary(local, interval);
  return localMidnightUtc(boundary, timezone);
}

export function followingPeriodEnd(
  periodEnd: Date,
  interval: string,
  billingTime: BillingTime,
  timezone: string,
): Date {
  if (billingTime === "anniversary") return nextPeriodEnd(periodEnd, interval);
  const local = localDate(periodEnd, timezone);
  return localMidnightUtc(addCalendarInterval(local, interval), timezone);
}

export function initialPlanProration(
  billableStart: Date,
  periodEnd: Date,
  billingTime: BillingTime,
  interval: string,
  timezone: string,
): ProrationWindow {
  if (billingTime === "anniversary") return { billableDays: 1, fullPeriodDays: 1 };
  const end = localDate(periodEnd, timezone);
  const start = localDate(billableStart, timezone);
  const fullStart = previousCalendarBoundary(end, interval);
  const fullPeriodDays = dayOrdinal(end) - dayOrdinal(fullStart);
  const billableDays = Math.max(0, dayOrdinal(end) - dayOrdinal(start));
  if (fullPeriodDays <= 0 || billableDays > fullPeriodDays)
    throw new Error("invalid_calendar_proration_window");
  return { billableDays, fullPeriodDays };
}

export function billingPeriodProration(
  billableStart: Date,
  fullPeriodStart: Date,
  fullPeriodEnd: Date,
  timezone: string,
): ProrationWindow {
  const end = localDate(fullPeriodEnd, timezone);
  const fullStart = localDate(fullPeriodStart, timezone);
  const start = localDate(billableStart, timezone);
  const fullPeriodDays = dayOrdinal(end) - dayOrdinal(fullStart);
  const billableDays = Math.max(0, dayOrdinal(end) - dayOrdinal(start));
  if (fullPeriodDays <= 0 || billableDays > fullPeriodDays)
    throw new Error("invalid_billing_proration_window");
  return { billableDays, fullPeriodDays };
}

export function localDate(value: Date, timezone: string): LocalDate {
  if (!Number.isFinite(value.getTime())) throw new Error("invalid_billing_timestamp");
  const parts = formatter(timezone).formatToParts(value);
  const numberPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error("invalid_billing_timezone_parts");
    return Number(part);
  };
  return { year: numberPart("year"), month: numberPart("month"), day: numberPart("day") };
}

export function localDateString(value: Date, timezone: string): string {
  const date = localDate(value, timezone);
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(
    date.day,
  ).padStart(2, "0")}`;
}

export function localMidnightUtc(date: LocalDate, timezone: string): Date {
  return localDateTimeUtc({ ...date, hour: 0, minute: 0, second: 0, millisecond: 0 }, timezone);
}

export function addTrialDays(start: Date, days: number, timezone: string): Date {
  if (!Number.isFinite(days) || days < 0) throw new Error("invalid_trial_period");
  const wholeDays = Math.trunc(days);
  const fractionalDays = days - wholeDays;
  const local = localDateTimeParts(start, timezone);
  const date = addDays(local, wholeDays);
  const civilEnd = localDateTimeUtc(
    {
      ...date,
      hour: local.hour,
      minute: local.minute,
      second: local.second,
      millisecond: start.getUTCMilliseconds(),
    },
    timezone,
  );
  return new Date(civilEnd.getTime() + fractionalDays * 86_400_000);
}

function localDateTimeUtc(
  date: LocalDate & { hour: number; minute: number; second: number; millisecond: number },
  timezone: string,
): Date {
  const target = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    date.hour,
    date.minute,
    date.second,
    date.millisecond,
  );
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localDateTimeParts(new Date(guess), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      new Date(guess).getUTCMilliseconds(),
    );
    const adjustment = target - actualAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  const result = new Date(guess);
  const roundTrip = localDateTimeParts(result, timezone);
  if (
    roundTrip.year !== date.year ||
    roundTrip.month !== date.month ||
    roundTrip.day !== date.day ||
    roundTrip.hour !== date.hour ||
    roundTrip.minute !== date.minute ||
    roundTrip.second !== date.second ||
    result.getUTCMilliseconds() !== date.millisecond
  ) {
    throw new Error("unsupported_local_time_transition");
  }
  return result;
}

export function nextLocalDay(value: Date, timezone: string): Date {
  return localMidnightUtc(addDays(localDate(value, timezone), 1), timezone);
}

export function nextPeriodEnd(start: Date, interval: string): Date {
  const result = new Date(start);
  if (interval === "weekly") result.setUTCDate(result.getUTCDate() + 7);
  else if (interval === "quarterly") addUtcMonthsClamped(result, 3);
  else if (interval === "yearly") addUtcMonthsClamped(result, 12);
  else if (interval === "one_time") return result;
  else addUtcMonthsClamped(result, 1);
  return result;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  const normalized = assertBillingTimezone(timezone);
  let value = LOCAL_PARTS_FORMATTERS.get(normalized);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone: normalized,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    LOCAL_PARTS_FORMATTERS.set(normalized, value);
  }
  return value;
}

function localDateTimeParts(value: Date, timezone: string) {
  const parts = formatter(timezone).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error("invalid_billing_timezone_parts");
    return Number(part);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function nextCalendarBoundary(date: LocalDate, interval: string): LocalDate {
  if (interval === "weekly") {
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    return addDays(date, weekday === 0 ? 1 : 8 - weekday);
  }
  if (interval === "monthly") return normalizeDate(date.year, date.month + 1, 1);
  if (interval === "quarterly") {
    const nextQuarterMonth = Math.floor((date.month - 1) / 3) * 3 + 4;
    return normalizeDate(date.year, nextQuarterMonth, 1);
  }
  if (interval === "yearly") return { year: date.year + 1, month: 1, day: 1 };
  if (interval === "one_time") return date;
  throw new Error("unsupported_billing_interval");
}

function previousCalendarBoundary(end: LocalDate, interval: string): LocalDate {
  if (interval === "weekly") return addDays(end, -7);
  if (interval === "monthly") return normalizeDate(end.year, end.month - 1, 1);
  if (interval === "quarterly") return normalizeDate(end.year, end.month - 3, 1);
  if (interval === "yearly") return { year: end.year - 1, month: 1, day: 1 };
  if (interval === "one_time") return end;
  throw new Error("unsupported_billing_interval");
}

function addCalendarInterval(date: LocalDate, interval: string): LocalDate {
  if (interval === "weekly") return addDays(date, 7);
  if (interval === "monthly") return normalizeDate(date.year, date.month + 1, date.day);
  if (interval === "quarterly") return normalizeDate(date.year, date.month + 3, date.day);
  if (interval === "yearly") return normalizeDate(date.year + 1, date.month, date.day);
  if (interval === "one_time") return date;
  throw new Error("unsupported_billing_interval");
}

function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function normalizeDate(year: number, month: number, day: number): LocalDate {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return {
    year: first.getUTCFullYear(),
    month: first.getUTCMonth() + 1,
    day: Math.min(day, lastDay),
  };
}

function dayOrdinal(date: LocalDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function addUtcMonthsClamped(value: Date, months: number): void {
  const desiredDay = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
  ).getUTCDate();
  value.setUTCDate(Math.min(desiredDay, lastDay));
}
