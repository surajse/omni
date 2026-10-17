// Minimal 5-field cron: `m h dom mon dow`.
// Supported per field: `*`, `*/n`, `a`, `a,b`, `a-b`, `a-b/n`.
// Times are evaluated in the server's local timezone.

interface CronField {
  any: boolean;
  values: Set<number>;
}

interface CronExpr {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseNumber(text: string, field: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new Error(`invalid cron ${field}: "${text}" is not a number`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`invalid cron ${field}: ${n} out of range ${min}-${max}`);
  return n;
}

function parseField(text: string, field: string, min: number, max: number): CronField {
  if (text === '*') return { any: true, values: new Set() };
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (part.length === 0) throw new Error(`invalid cron ${field}: empty list element`);
    const [range, stepText] = part.split('/');
    if (stepText !== undefined) {
      if (stepText === '' || !/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(`invalid cron ${field}: bad step "${stepText ?? ''}"`);
      }
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range?.includes('-')) {
      const [a, b] = range.split('-');
      from = parseNumber(a ?? '', field, min, max);
      to = parseNumber(b ?? '', field, min, max);
      if (from > to) throw new Error(`invalid cron ${field}: range ${from}-${to} is reversed`);
    } else {
      from = parseNumber(range ?? '', field, min, max);
      to = max;
      // A bare value (or bare value with step) starts at the value itself.
      if (stepText === undefined) {
        values.add(from);
        continue;
      }
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`invalid cron ${field}: "${text}" matches nothing`);
  return { any: false, values };
}

function parseDayOfWeek(text: string): CronField {
  // Parse with max 7, then fold 7 (Sunday) onto 0.
  const field = parseField(text, 'day of week', 0, 7);
  if (field.values.delete(7)) field.values.add(0);
  return field;
}

/** Parse a cron expression; throws on anything invalid. */
export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`invalid cron expression "${expr}": expected 5 fields (m h dom mon dow)`);
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return {
    minute: parseField(minute, 'minute', 0, 59),
    hour: parseField(hour, 'hour', 0, 23),
    dayOfMonth: parseField(dom, 'day of month', 1, 31),
    month: parseField(month, 'month', 1, 12),
    dayOfWeek: parseDayOfWeek(dow),
  };
}

/** Validate a cron expression; throws on invalid, returns void on valid. */
export function validateCron(expr: string): void {
  parseCron(expr);
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

/**
 * Standard cron day semantics: if both dom and dow are restricted, either may
 * match; if only one is restricted, it must match.
 */
function dayMatches(expr: CronExpr, date: Date): boolean {
  const dom = fieldMatches(expr.dayOfMonth, date.getDate());
  const dow = fieldMatches(expr.dayOfWeek, date.getDay());
  if (expr.dayOfMonth.any && expr.dayOfWeek.any) return true;
  if (expr.dayOfMonth.any) return dow;
  if (expr.dayOfWeek.any) return dom;
  return dom || dow;
}

/** True when `expr` fires during the minute containing `date` (local time). */
export function matchesCron(expr: string, date: Date): boolean {
  const parsed = parseCron(expr); // throws on invalid — fail loud, not silent
  return (
    fieldMatches(parsed.minute, date.getMinutes()) &&
    fieldMatches(parsed.hour, date.getHours()) &&
    dayMatches(parsed, date) &&
    fieldMatches(parsed.month, date.getMonth() + 1)
  );
}
