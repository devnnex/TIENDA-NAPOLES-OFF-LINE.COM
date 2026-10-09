/* Calendario de ventas de Colombia. Los intervalos incluyen el inicio y excluyen el cierre. */
const SalesShift = (() => {
  const zone = "America/Bogota";
  const dayMs = 86400000;
  const dateKey = (date = new Date()) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const midnight = (date) => Date.parse(`${date}T00:00:00-05:00`);
  const addDays = (date, days) => dateKey(new Date(midnight(date) + days * dayMs));
  const parseTime = (text, period) => {
    const value = String(text || "").trim();
    let hour, minute;
    if (/^\d{1,2}:\d{2}$/.test(value)) [hour, minute] = value.split(":").map(Number);
    else if (/^\d{1,4}$/.test(value)) {
      hour = Number(value.length <= 2 ? value : value.slice(0, -2));
      minute = value.length <= 2 ? 0 : Number(value.slice(-2));
    } else return null;
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59 || !["AM", "PM"].includes(period)) return null;
    return { minutes: (hour % 12 + (period === "PM" ? 12 : 0)) * 60 + minute, text: `${hour}:${String(minute).padStart(2, "0")}` };
  };
  const timeParts = (minutes) => ({
    text: `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, "0")}`,
    period: minutes >= 720 ? "PM" : "AM"
  });
  const timeLabel = (minutes) => { const value = timeParts(minutes); return `${value.text} ${value.period}`; };
  const bounds = (shift) => {
    if (!shift || !/^\d{4}-\d{2}-\d{2}$/.test(shift.date || "")) return null;
    const { startMinutes, endMinutes } = shift;
    if (![startMinutes, endMinutes].every(value => Number.isInteger(value) && value >= 0 && value < 1440) || startMinutes === endMinutes) return null;
    const start = midnight(shift.date) + startMinutes * 60000;
    const end = midnight(shift.date) + endMinutes * 60000 + (endMinutes < startMinutes ? dayMs : 0);
    return Number.isFinite(start) && dateKey(new Date(midnight(shift.date))) === shift.date ? { start, end } : null;
  };
  const today = (shift, now = new Date()) => {
    const date = dateKey(now), interval = bounds(shift), timestamp = Number(now);
    if (interval && timestamp >= midnight(shift.date) && timestamp < interval.end) {
      return { dateFrom: shift.date, dateTo: dateKey(new Date(interval.end - 1)),
        startAt: new Date(interval.start).toISOString(), endAt: new Date(interval.end).toISOString(), shiftId: shift.id };
    }
    // El tramo después de medianoche ya pertenece al turno anterior; no se cuenta dos veces en Hoy.
    const start = interval && dateKey(new Date(interval.end)) === date && timestamp >= interval.end
      ? Math.max(midnight(date), interval.end) : midnight(date);
    return { dateFrom: date, dateTo: date, startAt: new Date(start).toISOString(), endAt: new Date(midnight(date) + dayMs).toISOString() };
  };
  const range = (preset, shift, now = new Date()) => {
    if (preset === "today") return today(shift, now);
    const date = dateKey(now);
    let from = date, to = date;
    if (preset === "yesterday") from = to = addDays(date, -1);
    if (preset === "7days") from = addDays(date, -6);
    if (preset === "15days") from = addDays(date, -14);
    if (preset === "30days") from = addDays(date, -29);
    if (preset === "month") from = `${date.slice(0, 7)}-01`;
    if (preset === "year") from = `${date.slice(0, 4)}-01-01`;
    return { dateFrom: from, dateTo: to };
  };
  const matches = (date, filters) => {
    const timestamp = Date.parse(date);
    if (!Number.isFinite(timestamp)) return false;
    if (filters.startAt && timestamp < Date.parse(filters.startAt)) return false;
    if (filters.endAt && timestamp >= Date.parse(filters.endAt)) return false;
    const key = dateKey(new Date(timestamp));
    return key >= filters.dateFrom && key <= filters.dateTo;
  };
  return { zone, dateKey, parseTime, timeParts, timeLabel, bounds, today, range, matches };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SalesShift;
