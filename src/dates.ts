import { realpathSync } from "node:fs";

export type TimeKey = [number, string] | null;
export type Args = Record<string, string | undefined>;
const TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

function civil(year: number, month: number, day: number): Date | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function parseTime(value: unknown): TimeKey {
  if (typeof value !== "string") return null;
  const m = TIME.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const date = civil(year, month, day);
  if (!date || hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (m[8] && m[8] !== "Z") {
    const digits = m[8].slice(1).replace(":", "");
    const h = Number(digits.slice(0, 2)), min = Number(digits.slice(2));
    if (h > 23 || min > 59) return null;
    offset = (h * 60 + min) * 60 * (m[8][0] === "+" ? 1 : -1);
  }
  const seconds = date.getTime() / 1000 + hour * 3600 + minute * 60 + second - offset;
  const utcYear = new Date(seconds * 1000).getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) return null;
  return [seconds, (m[7] || "").replace(/0+$/, "")];
}

export function compareTime(a: TimeKey, b: TimeKey): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}

export function zoneFormatter(zone: string): Intl.DateTimeFormat {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", era: "short",
  });
  const options = formatter.resolvedOptions();
  if (options.calendar !== "gregory" || options.numberingSystem !== "latn" || options.hourCycle !== "h23") {
    throw new Error("Could not verify the Gregorian OS-local time zone");
  }
  return formatter;
}

export function formatTime(value: unknown, formatter: Intl.DateTimeFormat): string | null {
  const key = parseTime(value);
  if (!key) return null;
  const parts = Object.fromEntries(formatter.formatToParts(new Date(key[0] * 1000)).map(p => [p.type, p.value]));
  if (parts.era !== "AD" || Number(parts.year) > 9999) return null;
  return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function systemZone(localtime = "/etc/localtime"): string {
  let path: string;
  try { path = realpathSync(localtime); }
  catch { throw new Error("Could not read the OS-local time zone; check the system time zone configuration and try again"); }
  const marker = "/zoneinfo/";
  if (!path.includes(marker)) throw new Error("The OS-local time zone is not a supported IANA zoneinfo link; startup was refused");
  const name = path.slice(path.indexOf(marker) + marker.length);
  try { zoneFormatter(name); }
  catch { throw new Error("The OS-local IANA time zone is unsupported; startup was refused"); }
  return name;
}

export function localDate(key: TimeKey, formatter: Intl.DateTimeFormat): [number, number, number] | null {
  if (!key) return null;
  const parts = Object.fromEntries(formatter.formatToParts(new Date(key[0] * 1000)).map(p => [p.type, p.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  return parts.era === "AD" && civil(year, month, day) ? [year, month, day] : null;
}

export class Period {
  year: number | null = null;
  month: number | null = null;
  day: number | null = null;
  label: string;
  formatter: Intl.DateTimeFormat;
  start: string | null = null;
  end: string | null = null;
  constructor(args: Args, readonly zone: string) {
    this.formatter = zoneFormatter(zone);
    if (args.start !== undefined || args.end !== undefined) {
      const valid = (value: string | undefined) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && civil(...value.split("-").map(Number) as [number, number, number]) !== null;
      if (!valid(args.start) || !valid(args.end) || args.start! > args.end!
        || ["year", "month", "day"].some(field => args[field] !== undefined)) throw Error("Invalid date range");
      this.start = args.start!;
      this.end = args.end!;
      this.label = `${this.start} ~ ${this.end}`;
      return;
    }
    let previous = true;
    for (const field of ["year", "month", "day"] as const) {
      const raw = args[field];
      if (raw === "" || raw === undefined || raw === null) { previous = false; continue; }
      if (!previous || typeof raw !== "string" || !/^[0-9]{1,4}$/.test(raw)) throw Error("Invalid date filter");
      this[field] = Number(raw);
    }
    if (this.year !== null && !civil(this.year, this.month ?? 1, this.day ?? 1)) throw Error("Invalid date filter");
    this.label = this.year === null ? "All" : String(this.year).padStart(4, "0")
      + (this.month === null ? "" : "-" + String(this.month).padStart(2, "0"))
      + (this.day === null ? "" : "-" + String(this.day).padStart(2, "0"));
  }
  contains(key: TimeKey): boolean {
    if (this.start && this.end) {
      const date = localDate(key, this.formatter);
      const text = date?.map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0")).join("-");
      return !!text && text >= this.start && text <= this.end;
    }
    if (this.year === null) return true;
    const current = localDate(key, this.formatter);
    return !!current && current[0] === this.year
      && (this.month === null || current[1] === this.month) && (this.day === null || current[2] === this.day);
  }
}
