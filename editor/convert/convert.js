'use strict';
/**
 * Converts Google Sheets HTML exports in this folder to .wsheet files.
 * Usage: node convert.js
 * No external dependencies required.
 */

const fs   = require('fs');
const path = require('path');

const DIR = __dirname;

/* ── CSS helpers ──────────────────────────────────────────── */
function parsePtPx(val) {
  const pt = val.match(/^([\d.]+)pt$/i);
  if (pt) return Math.round(parseFloat(pt[1]) * 1.333);
  const px = val.match(/^([\d.]+)px$/i);
  if (px) return Math.round(parseFloat(px[1]));
  return null;
}

function normColor(val) {
  val = val.trim();
  if (/^#[0-9a-f]{3,6}$/i.test(val)) return val.toLowerCase();
  const m = val.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);
  if (m) return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
  return null;
}

function parseCssClass(decls) {
  const result = {};
  for (const raw of decls.split(';')) {
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const key = raw.slice(0, colon).trim().toLowerCase();
    const val = raw.slice(colon + 1).trim();
    const vl  = val.toLowerCase();

    if (key === 'font-weight' && vl === 'bold')  { result.bold = true; continue; }
    if (key === 'font-style'  && vl === 'italic') { result.italic = true; continue; }
    if (key === 'color')            { const c = normColor(val); if (c) result.color = c; continue; }
    if (key === 'background-color') { const c = normColor(val); if (c) result.bgColor = c; continue; }
    if (key === 'text-align')  {
      if (['left', 'center', 'right'].includes(vl)) result.align = vl;
      continue;
    }
    if (key === 'font-size') {
      const s = parsePtPx(val);
      if (s) result.fontSize = s;
      continue;
    }
    if (key === 'font-family') {
      const families = val.split(',').map(f => f.replace(/["']/g, '').trim());
      result.fontFamily = families.find(f => !f.toLowerCase().startsWith('docs-')) || families[0];
      continue;
    }
    if (key === 'border-top')    { result.borderTop    = !vl.includes('none'); continue; }
    if (key === 'border-bottom') { result.borderBottom = !vl.includes('none'); continue; }
    if (key === 'border-left')   { result.borderLeft   = !vl.includes('none'); continue; }
    if (key === 'border-right')  { result.borderRight  = !vl.includes('none'); continue; }
  }
  return result;
}

/* ── HTML helpers (no DOM — regex only) ──────────────────── */
function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function convertHtml(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');

  /* 1 ── Build CSS class map */
  const styleMap = {};
  const styleRe  = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleRe.exec(src)) !== null) {
    const cssRe = /\.waffle\s+\.(\w+)\s*\{([^}]*)\}/g;
    let cm;
    while ((cm = cssRe.exec(sm[1])) !== null) {
      styleMap[cm[1]] = parseCssClass(cm[2]);
    }
  }

  /* 2 ── Extract tbody */
  const tbodyMatch = src.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) throw new Error('No <tbody> found');
  const tbodyHtml = tbodyMatch[1];

  /* 3 ── Parse rows */
  const aoa     = [];
  const formats = {};
  const borders = {};

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(tbodyHtml)) !== null) {
    const rowHtml = rowM[1];
    const rowIdx  = aoa.length;
    const rowData = [];

    /* Only <td> cells — skip <th> row-header */
    const cellRe = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
    let cellM;
    let colIdx = 0;
    while ((cellM = cellRe.exec(rowHtml)) !== null) {
      const attrs   = cellM[1];
      const content = stripTags(cellM[2]);
      rowData.push(content);

      /* Extract class name */
      const clsM = attrs.match(/class=["']([^"']*)["']/i);
      const cls  = clsM ? clsM[1].trim() : '';
      const s    = styleMap[cls];

      if (s) {
        const fmt = {};
        if (s.bold)       fmt.bold       = true;
        if (s.italic)     fmt.italic     = true;
        if (s.color     && s.color     !== '#000000') fmt.color     = s.color;
        if (s.bgColor   && s.bgColor   !== '#ffffff') fmt.bgColor   = s.bgColor;
        if (s.fontSize)   fmt.fontSize   = s.fontSize;
        if (s.fontFamily) fmt.fontFamily = s.fontFamily;
        if (s.align)      fmt.align      = s.align;
        if (Object.keys(fmt).length) {
          if (!formats[rowIdx]) formats[rowIdx] = {};
          formats[rowIdx][colIdx] = fmt;
        }

        if (s.borderTop || s.borderBottom || s.borderLeft || s.borderRight) {
          if (!borders[rowIdx]) borders[rowIdx] = {};
          borders[rowIdx][colIdx] = {
            top:    !!s.borderTop,
            bottom: !!s.borderBottom,
            left:   !!s.borderLeft,
            right:  !!s.borderRight,
          };
        }
      }

      colIdx++;
    }
    aoa.push(rowData);
  }

  /* 4 ── Trim trailing empty rows */
  let lastRow = aoa.length - 1;
  while (lastRow >= 0 && aoa[lastRow].every(v => v === '')) lastRow--;
  const trimmedData = aoa.slice(0, lastRow + 1);

  const borderCount = Object.values(borders).reduce((n, cols) => n + Object.keys(cols).length, 0);
  console.log(`  rows: ${trimmedData.length}, bordered cells: ${borderCount}`);

  return JSON.stringify({ version: 1, data: trimmedData, formats, borders });
}

/* ── Main ─────────────────────────────────────────────────── */
const DATA_DIR = path.join(__dirname, '..', 'data');

const files = fs.readdirSync(DIR).filter(f => /\.(html|htm)$/i.test(f));
if (files.length === 0) {
  console.log('No HTML files found in', DIR);
  process.exit(0);
}

let ok = 0, fail = 0;
for (const file of files) {
  const src     = path.join(DIR, file);
  const outName = file.replace(/\.(html|htm)$/i, '.wsheet');
  const out     = path.join(DATA_DIR, outName);
  process.stdout.write(`Converting: ${file} → data/${outName} … `);
  try {
    const json = convertHtml(src);
    fs.writeFileSync(out, json, 'utf-8');
    fs.unlinkSync(src);   /* delete original HTML */
    ok++;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    fail++;
  }
}
console.log(`\nDone: ${ok} converted, ${fail} failed.`);

/* ── Rebuild data/index.json ──────────────────────────────── */
const allWsheets = fs.readdirSync(DATA_DIR)
  .filter(f => /\.wsheet$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
fs.writeFileSync(
  path.join(DATA_DIR, 'index.json'),
  JSON.stringify(allWsheets, null, 2) + '\n',
  'utf-8'
);
console.log(`index.json updated — ${allWsheets.length} files listed.`);
