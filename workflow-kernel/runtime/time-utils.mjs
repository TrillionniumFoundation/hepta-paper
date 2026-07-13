export function nowIso(now = new Date()) { return now instanceof Date ? now.toISOString() : new Date(now).toISOString(); }
export function sortByMtimeDesc(records = []) { return [...records].sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0)); }
