import { parseHTML } from 'linkedom';

export const TABLE_LIMITS = Object.freeze({ rows: 200, columns: 50, cell: 8192 });

function validateRow(row) {
    if (row.length > TABLE_LIMITS.columns) throw new Error('Tables support at most 50 columns');
    if (row.some(cell => cell.length > TABLE_LIMITS.cell)) throw new Error('Table cell exceeds 8192 characters');
}

export function csvRows(text, delimiter = ',') {
    if (![',', ';', '\t'].includes(delimiter)) throw new Error('Unsupported CSV delimiter');
    text = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], cell = '', quoted = false, closed = false, quotedValue = false;
    const endCell = () => { row.push(cell); cell = ''; closed = false; validateRow(row); };
    const endRow = () => {
        endCell();
        if (row.length !== 1 || row[0] !== '' || quotedValue) rows.push(row);
        if (rows.length > TABLE_LIMITS.rows + 1) throw new Error('Tables support at most 200 data rows');
        row = []; quotedValue = false;
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') { cell += '"'; index++; }
                else { quoted = false; closed = true; }
            } else cell += char;
        } else if (char === delimiter) endCell();
        else if (char === '\r' || char === '\n') {
            if (char === '\r' && text[index + 1] === '\n') index++;
            endRow();
        } else if (closed) {
            if (char !== ' ') throw new Error('Unexpected text after a quoted CSV value');
        } else if (char === '"') {
            if (cell) throw new Error('Quote inside an unquoted CSV value');
            quoted = true; quotedValue = true;
        } else cell += char;
        if (cell.length > TABLE_LIMITS.cell) throw new Error('Table cell exceeds 8192 characters');
    }
    if (quoted) throw new Error('Unclosed CSV quote');
    if (cell || row.length || closed) endRow();
    return rows;
}

export function htmlRows(html, tableIndex = 1) {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    document.querySelectorAll('script,style,title').forEach(node => node.remove());
    const table = document.querySelectorAll('table')[tableIndex - 1];
    if (!table) return [];
    const rows = [];
    for (const element of table.querySelectorAll('tr')) {
        if (element.closest('table') !== table) continue;
        const row = [];
        for (const cell of element.children) {
            if (!['TD', 'TH'].includes(cell.tagName)) continue;
            if (Number(cell.getAttribute('colspan') || 1) !== 1 || Number(cell.getAttribute('rowspan') || 1) !== 1) {
                throw new Error('Merged HTML table cells are not supported');
            }
            const copy = cell.cloneNode(true);
            copy.querySelectorAll('table').forEach(nested => nested.remove());
            row.push(copy.innerText ?? copy.textContent ?? '');
        }
        if (!row.length) continue;
        validateRow(row);
        rows.push(row);
        if (rows.length > TABLE_LIMITS.rows + 1) throw new Error('Tables support at most 200 data rows');
    }
    return rows;
}

export function tableRecords(rows, hasHeader = true) {
    if (!rows.length) return [];
    const width = rows[0].length;
    if (rows.some(row => row.length !== width)) throw new Error('Table rows have inconsistent column counts');
    const values = hasHeader ? rows.slice(1) : rows;
    if (values.length > TABLE_LIMITS.rows) throw new Error('Tables support at most 200 data rows');
    const used = new Set();
    const columns = rows[0].map((value, index) => {
        const raw = hasHeader ? value.trim() : '';
        if (raw.length > 128) throw new Error('Table column name exceeds 128 characters');
        const base = raw && !['__proto__', 'constructor', 'prototype'].includes(raw) ? raw : `column_${index + 1}`;
        let name = base, suffix = 2;
        while (used.has(name)) {
            const tag = `_${suffix++}`;
            name = `${base.slice(0, 128 - tag.length)}${tag}`;
        }
        used.add(name);
        return name;
    });
    return values.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

export function extractTable(rule, input) {
    const options = rule.options;
    if (rule.source === 'htmlTable') return tableRecords(htmlRows(input.html, options.tableIndex), options.hasHeader);
    const files = input.attachments.filter(file => file.name === options.attachmentName);
    if (files.length > 1) throw new Error('CSV attachment name is ambiguous');
    if (!files.length) return [];
    return tableRecords(csvRows(files[0].text, options.delimiter), options.hasHeader);
}

export function applyTableFilter(value, filter) {
    switch (filter.type) {
        case 'tableRows': return value.slice(filter.start - 1, filter.end);
        case 'tableColumns':
            if (value.length && filter.columns.some(column => !Object.hasOwn(value[0], column))) throw new Error('Selected table column does not exist');
            return value.map(row => Object.fromEntries(filter.columns.map(column => [column, row[column]])));
        case 'tableTrim': return value.map(row => Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, cell.trim()])));
        default: throw new Error('Unknown table filter');
    }
}
