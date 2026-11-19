// Minimal CSV reader for a published Google Sheet tab: quoted fields, doubled
// quotes, commas and newlines inside quotes. First row is the header.
export function parseCsv(text) {
  const table = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      table.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    table.push(row);
  }

  const [header, ...body] = table;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body
    .filter((cells) => cells.some((c) => c.trim() !== ''))
    .map((cells) => {
      const out = {};
      keys.forEach((key, i) => {
        const value = (cells[i] ?? '').trim();
        if (key && value !== '') out[key] = value;
      });
      return out;
    });
}
