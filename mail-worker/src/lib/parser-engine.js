import { RE2JS } from 're2js';
import { parseHTML } from 'linkedom';
import { extractTable, applyTableFilter } from './parser-table';

export const PARSER_LIMITS = Object.freeze({ fields: 30, filters: 12, pattern: 256, inputBytes: 131072, value: 8192 });
export const PARSER_SOURCES = ['subject', 'text', 'htmlText', 'from', 'to', 'htmlTable', 'csvAttachment'];
export const PARSER_FILTERS = ['between', 'regex', 'replace', 'trim', 'collapse', 'lower', 'upper', 'default', 'number', 'date'];
export const TABLE_FILTERS = ['tableRows', 'tableColumns', 'tableTrim'];
export const isTableSource = source => ['htmlTable', 'csvAttachment'].includes(source);
const encoder = new TextEncoder();

export function checkSize(value, limit = PARSER_LIMITS.inputBytes) {
    if (encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength > limit) {
        throw new Error('Parser input or output exceeds the size limit');
    }
}

function boundedString(value, max, name) {
    if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${name}`);
    return value;
}

function compile(filter) {
    boundedString(filter.pattern, PARSER_LIMITS.pattern, 'regular expression');
    if (!filter.pattern) throw new Error('Regular expression is required');
    const flags = filter.flags ?? 'm';
    if (typeof flags !== 'string' || !/^[ims]{0,3}$/.test(flags)) throw new Error('Only i, m and s flags are supported');
    let bits = 0;
    if (flags.includes('i')) bits |= RE2JS.CASE_INSENSITIVE;
    if (flags.includes('m')) bits |= RE2JS.MULTILINE;
    if (flags.includes('s')) bits |= RE2JS.DOTALL;
    // Do not enable optional lookbehind extensions or a backtracking engine.
    const pattern = RE2JS.compile(filter.pattern, bits);
    const group = filter.group ?? 0;
    if (!Number.isInteger(group) || group < 0 || group > pattern.groupCount()) throw new Error('Invalid capture group');
    return { pattern, group };
}

export function validateRules(rules) {
    checkSize(rules, 32768);
    if (!Array.isArray(rules) || rules.length < 1 || rules.length > PARSER_LIMITS.fields) throw new Error('Use between 1 and 30 fields');
    const keys = new Set();
    for (const rule of rules) {
        if (!rule || typeof rule.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rule.key) || ['constructor', 'prototype'].includes(rule.key) || keys.has(rule.key)) {
            throw new Error('Field keys must be unique identifiers beginning with a letter');
        }
        keys.add(rule.key);
        if (!PARSER_SOURCES.includes(rule.source)) throw new Error(`Invalid source for ${rule.key}`);
        const table = isTableSource(rule.source);
        if (table) {
            const options = rule.options;
            if (!options || typeof options.hasHeader !== 'boolean') throw new Error('Select whether the table has a header row');
            if (rule.source === 'htmlTable' && (!Number.isInteger(options.tableIndex) || options.tableIndex < 1 || options.tableIndex > 20)) throw new Error('HTML table index must be between 1 and 20');
            if (rule.source === 'csvAttachment') {
                boundedString(options.attachmentName, 255, 'CSV attachment name');
                if (!options.attachmentName || !options.attachmentName.toLowerCase().endsWith('.csv')) throw new Error('An exact .csv attachment name is required');
                if (![',', ';', '\t'].includes(options.delimiter)) throw new Error('Unsupported CSV delimiter');
            }
        }
        if (rule.required !== undefined && typeof rule.required !== 'boolean') throw new Error('Required must be a boolean');
        if (!Array.isArray(rule.filters) || rule.filters.length > PARSER_LIMITS.filters) throw new Error('Use at most 12 filters per field');
        for (const filter of rule.filters) {
            if (!filter || !(table ? TABLE_FILTERS : PARSER_FILTERS).includes(filter.type)) throw new Error('Filter does not match the selected data source');
            if (filter.type === 'tableRows' && (!Number.isInteger(filter.start) || !Number.isInteger(filter.end) || filter.start < 1 || filter.end < filter.start || filter.end > 200)) throw new Error('Table row range must be between 1 and 200');
            if (filter.type === 'tableColumns' && (!Array.isArray(filter.columns) || !filter.columns.length || filter.columns.length > 50 || filter.columns.some(column => typeof column !== 'string' || !column || column.length > 128) || new Set(filter.columns).size !== filter.columns.length)) throw new Error('Select unique table column names');
            if (filter.type === 'regex') compile(filter);
            if (filter.type === 'between') {
                boundedString(filter.start ?? '', 512, 'start marker');
                boundedString(filter.end ?? '', 512, 'end marker');
                if (!filter.start && !filter.end) throw new Error('At least one boundary is required');
            }
            if (filter.type === 'replace') {
                boundedString(filter.search, 512, 'search text');
                boundedString(filter.replacement ?? '', 512, 'replacement text');
                if (!filter.search) throw new Error('Search text is required');
            }
            if (filter.type === 'default') boundedString(filter.value, 512, 'default value');
            if (filter.type === 'date' && !['YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].includes(filter.inputFormat)) {
                throw new Error('Unsupported input date format');
            }
        }
    }
    if (new Set(rules.filter(rule => rule.source === 'csvAttachment').map(rule => rule.options.attachmentName)).size > 5) throw new Error('Use at most 5 CSV attachments per email');
    // Persist only supported properties, keeping unknown input out of snapshots.
    return rules.map(rule => ({ key: rule.key, source: rule.source, required: !!rule.required,
        ...(isTableSource(rule.source) ? { options: { hasHeader: rule.options.hasHeader, ...(rule.source === 'htmlTable' ? { tableIndex: rule.options.tableIndex } : { attachmentName: rule.options.attachmentName, delimiter: rule.options.delimiter }) } } : {}),
        filters: rule.filters.map(filter => {
        const value = { type: filter.type };
        const properties = { between: ['start', 'end'], regex: ['pattern', 'flags', 'group'], replace: ['search', 'replacement'], default: ['value'], date: ['inputFormat'], tableRows: ['start', 'end'], tableColumns: ['columns'] }[filter.type] || [];
        for (const key of properties) if (filter[key] !== undefined) value[key] = filter[key];
        return value;
    }) }));
}

export function emailInput(email) {
    const input = {
        subject: String(email.subject ?? ''), text: String(email.text ?? ''), html: String(email.html ?? email.content ?? ''),
        from: String(email.from ?? email.sendEmail ?? ''), to: String(email.to ?? email.toEmail ?? '')
    };
    if (email.attachments !== undefined) {
        if (!Array.isArray(email.attachments) || email.attachments.length > 5) throw new Error('Use at most 5 CSV attachments per email');
        input.attachments = email.attachments.map(file => {
            boundedString(file?.name, 255, 'attachment name');
            boundedString(file?.text, 65536, 'CSV attachment text');
            checkSize(file.text, 65536);
            return { name: file.name, text: file.text };
        });
    } else input.attachments = [];
    checkSize(input);
    return input;
}

function htmlText(html) {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    document.querySelectorAll('script,style,title').forEach(node => node.remove());
    return document.body.innerText || '';
}

function dateValue(value, format) {
    const text = String(value).trim();
    const separator = format.includes('-') ? '-' : '/';
    const parts = text.split(separator);
    const tokens = format.split(/[-/]/);
    if (parts.length !== 3 || parts.some((part, index) => !(tokens[index] === 'YYYY' ? /^\d{4}$/ : /^\d{2}$/).test(part))) {
        throw new Error('Date does not match the selected format');
    }
    const values = Object.fromEntries(tokens.map((key, index) => [key, Number(parts[index])]));
    const { YYYY: year, MM: month, DD: day } = values;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Invalid date');
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function applyFilter(input, filter) {
    const value = String(input);
    switch (filter.type) {
        case 'between': {
            let start = 0;
            if (filter.start) {
                const position = value.indexOf(filter.start);
                if (position < 0) return '';
                start = position + filter.start.length;
            }
            const end = filter.end ? value.indexOf(filter.end, start) : value.length;
            return end < 0 ? '' : value.slice(start, end);
        }
        case 'regex': {
            const { pattern, group } = compile(filter);
            const match = pattern.matcher(value);
            return match.find() ? match.group(group) ?? '' : '';
        }
        case 'replace': return value.split(filter.search).join(filter.replacement ?? '');
        case 'trim': return value.trim();
        case 'collapse': return value.replace(/\s+/g, ' ').trim();
        case 'lower': return value.toLowerCase();
        case 'upper': return value.toUpperCase();
        case 'default': return value.trim() ? input : filter.value;
        case 'number': {
            const numeric = value.trim();
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric) || !Number.isFinite(Number(numeric))) throw new Error('Invalid number');
            return Number(numeric);
        }
        case 'date': return dateValue(input, filter.inputFormat);
        default: throw new Error('Unknown filter');
    }
}

export function parseEmail(rules, email, trace = false) {
    const normalized = validateRules(rules);
    const input = emailInput(email);
    let extractedHtml;
    const data = {};
    const errors = [];
    const fields = [];
    let traceBytes = 0;
    const addStep = (steps, type, value) => {
        traceBytes += encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
        if (traceBytes > 900000) throw new Error('Preview trace exceeds the size limit');
        steps.push({ type, value });
    };
    for (const rule of normalized) {
        const table = isTableSource(rule.source);
        let value;
        const steps = [];
        try {
            value = table ? extractTable(rule, input) : rule.source === 'htmlText' ? (extractedHtml ??= htmlText(input.html)) : input[rule.source];
            if (trace) addStep(steps, 'source', value);
            for (const filter of rule.filters) {
                value = table ? applyTableFilter(value, filter) : applyFilter(value, filter);
                checkSize(value);
                if (trace) addStep(steps, filter.type, value);
            }
            if (!table && String(value).length > PARSER_LIMITS.value) throw new Error('Field output exceeds 8192 characters');
            if (rule.required && (table ? !value.length : !String(value).trim())) throw new Error('Required field is empty');
            data[rule.key] = value;
        } catch (error) {
            data[rule.key] = null;
            errors.push({ field: rule.key, message: error.message });
        }
        if (trace) fields.push({ key: rule.key, steps });
    }
    checkSize(data);
    if (trace && traceBytes > 900000) throw new Error('Preview trace exceeds the size limit');
    if (trace) checkSize(fields, 1048576);
    return { data, errors, ...(trace ? { fields } : {}) };
}

export function csvExport(rows, tableField = '') {
    const keys = new Set();
    for (const row of rows) {
        for (const key of Object.keys(row.data)) if (key !== tableField) keys.add(key);
        if (tableField) {
            if (!Array.isArray(row.data[tableField])) throw new Error('Selected export field is not a table');
            for (const record of row.data[tableField]) for (const column of Object.keys(record)) keys.add(`${tableField}.${column}`);
        }
    }
    const columns = [...keys];
    const escape = value => {
        let text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
        if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    };
    const lines = [];
    let bytes = 3;
    const append = cells => {
        const line = cells.map(escape).join(',');
        bytes += encoder.encode(line).byteLength + 2;
        if (bytes > 4194304) throw new Error('CSV export exceeds 4 MiB; reduce the result batch');
        lines.push(line);
    };
    append(['_job_id', '_email_id', '_version', '_parsed_at', ...columns]);
    for (const row of rows) for (const record of tableField ? row.data[tableField] : [null]) {
        append([row.id, row.emailId, row.version, row.parsedAt, ...columns.map(key => tableField && key.startsWith(`${tableField}.`) ? record[key.slice(tableField.length + 1)] : row.data[key])]);
    }
    return '\uFEFF' + lines.join('\r\n');
}
