export function nextPeriodEnd(start: Date, interval: string): Date {
  const result = new Date(start);
  if (interval === "weekly") result.setUTCDate(result.getUTCDate() + 7);
  else if (interval === "quarterly") addUtcMonthsClamped(result, 3);
  else if (interval === "yearly") addUtcMonthsClamped(result, 12);
  else if (interval === "one_time") return result;
  else addUtcMonthsClamped(result, 1);
  return result;
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
