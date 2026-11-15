import { db } from './db.js';

const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

// All SQL expressions come from the caller's fixed column map. User values are bound.
// Pagination is opt-in so existing API clients keep their original response shape.
export function adminTable(query, { from, select, columns, defaultSort, tieBreak }) {
  const allowed = new Set(['paginated', 'page', 'pageSize', 'q', 'sort', 'order', ...Object.keys(columns).map(k => `filter_${k}`)]);
  for (const key of Object.keys(query)) if (!allowed.has(key)) invalid(`Unknown table parameter: ${key}`);
  if (query.paginated !== '1') invalid('paginated must be 1');
  const integer = (key, fallback, max) => {
    const value = query[key] ?? String(fallback);
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) invalid(`Invalid ${key}`);
    return Number(value);
  };
  let page = integer('page', 1, 1000000000);
  const pageSize = integer('pageSize', 25, 100);
  const sort = query.sort ?? defaultSort;
  if (!Object.hasOwn(columns, sort)) invalid('Invalid sort column');
  const order = query.order ?? 'desc';
  if (!['asc', 'desc'].includes(order)) invalid('Invalid sort order');
  const text = key => {
    const value = query[key] ?? '';
    if (typeof value !== 'string' || value.length > 200) invalid(`Invalid ${key}`);
    return value.trim();
  };
  const clauses = [], params = [];
  const expression = sql => `COALESCE(CAST((${sql}) AS TEXT),'')`;
  const q = text('q');
  if (q) {
    clauses.push(`instr(lower(${Object.values(columns).map(expression).join(" || ' ' || ")}), lower(?)) > 0`);
    params.push(q);
  }
  for (const [key, sql] of Object.entries(columns)) {
    const value = text(`filter_${key}`);
    if (value) { clauses.push(`instr(lower(${expression(sql)}), lower(?)) > 0`); params.push(value); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS total FROM ${from} ${where}`).get(...params).total;
  const pages = Math.max(1, Math.ceil(total / pageSize)); page = Math.min(page, pages);
  const items = db.prepare(`SELECT ${select} FROM ${from} ${where} ORDER BY ${columns[sort]} ${order}, ${tieBreak} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { items, total, page, pageSize, pages };
}
