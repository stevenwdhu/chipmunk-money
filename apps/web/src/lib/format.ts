import { formatDateShort, formatMoney } from '@chipmunk/shared'

export const money = (minor: number, opts?: { signed?: boolean }) => formatMoney(minor, 'CAD', opts)

export function shortDate(date: string, today?: string) {
  return formatDateShort(date, today ? Number(today.slice(0, 4)) : undefined)
}

export function relativeDay(date: string, today: string) {
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff === 1) return 'Tomorrow'
  if (diff > 1 && diff < 7) return `In ${diff} days`
  if (diff < -1 && diff > -7) return `${-diff} days ago`
  return formatDateShort(date, Number(today.slice(0, 4)))
}

/** `relativeDay` mid-sentence: "next today", "in 3 days", but a date keeps its capital ("Oct 13"). */
export function relativeDayInline(date: string, today: string) {
  const text = relativeDay(date, today)
  return text === formatDateShort(date, Number(today.slice(0, 4))) ? text : text.toLowerCase()
}

export function percent(n: number, digits = 0) {
  // A change that rounds away is 0%, not -0%.
  const s = (n * 100).toFixed(digits)
  return `${Number(s) === 0 ? (0).toFixed(digits) : s}%`
}

/** A moment as "Oct 2, 3:45 p.m." in the app's time zone (adds the year when it isn't this year). */
/** `seconds`: down to the second, for a log where several land in a minute. */
export function dateTime(iso: string, timeZone?: string, opts: { seconds?: boolean } = {}) {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: opts.seconds ? '2-digit' : undefined,
    timeZone,
  }).format(d)
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export function timeAgo(iso: string, timeZone?: string, now = Date.now()) {
  const s = Math.round((now - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} day${s < 2 * 86_400 ? '' : 's'} ago`
  return dateTime(iso, timeZone)
}
