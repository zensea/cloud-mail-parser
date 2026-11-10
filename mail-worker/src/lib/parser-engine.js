import { RE2JS } from 're2js';
import { parseHTML } from 'linkedom';

export const PARSER_LIMITS = Object.freeze({ fields: 30, filters: 12, pattern: 256, inputBytes: 131072, value: 8192 });
export const PARSER_SOURCES = ['subject', 'text', 'htmlText', 'from', 'to'];
export const PARSER_FILTERS = ['between', 'regex', 'replace', 'trim', 'collapse', 'lower', 'upper', 'default', 'number', 'date'];
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
        if (rule.required !== undefined && typeof rule.required !== 'boolean') throw new Error('Required must be a boolean');
        if (!Array.isArray(rule.filters) || rule.filters.length > PARSER_LIMITS.filters) throw new Error('Use at most 12 filters per field');
        for (const filter of rule.filters) {
            if (!filter || !PARSER_FILTERS.includes(filter.type)) throw new Error('Unknown filter');
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
    // Persist only supported properties, keeping unknown input out of snapshots.
    return rules.map(rule => ({ key: rule.key, source: rule.source, required: !!rule.required, filters: rule.filters.map(filter => {
        const value = { type: filter.type };
        const properties = { between: ['start', 'end'], regex: ['pattern', 'flags', 'group'], replace: ['search', 'replacement'], default: ['value'], date: ['inputFormat'] }[filter.type] || [];
        for (const key of properties) if (filter[key] !== undefined) value[key] = filter[key];
        return value;
    }) }));
}

export function emailInput(email) {
    const input = {
        subject: String(email.subject ?? ''), text: String(email.text ?? ''), html: String(email.html ?? email.content ?? ''),
        from: String(email.from ?? email.sendEmail ?? ''), to: String(email.to ?? email.toEmail ?? '')
    };
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
        traceBytes += encoder.encode(String(value)).byteLength;
        if (traceBytes > 900000) throw new Error('Preview trace exceeds the size limit');
        steps.push({ type, value });
    };
    for (const rule of normalized) {
        let value = rule.source === 'htmlText' ? (extractedHtml ??= htmlText(input.html)) : input[rule.source];
        const steps = [];
        if (trace) addStep(steps, 'source', value);
        try {
            for (const filter of rule.filters) {
                value = applyFilter(value, filter);
                checkSize(String(value));
                if (trace) addStep(steps, filter.type, value);
            }
            if (String(value).length > PARSER_LIMITS.value) throw new Error('Field output exceeds 8192 characters');
            if (rule.required && !String(value).trim()) throw new Error('Required field is empty');
            data[rule.key] = value;
        } catch (error) {
            data[rule.key] = null;
            errors.push({ field: rule.key, message: error.message });
        }
        if (trace) fields.push({ key: rule.key, steps });
    }
    checkSize(data);
    if (trace) checkSize(fields, 1048576);
    return { data, errors, ...(trace ? { fields } : {}) };
}

export function csvExport(rows) {
    const keys = [...new Set(rows.flatMap(row => Object.keys(row.data)))];
    const escape = value => {
        let text = String(value ?? '');
        if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ['_job_id', '_email_id', '_version', '_parsed_at', ...keys];
    return '\uFEFF' + [header, ...rows.map(row => [row.id, row.emailId, row.version, row.parsedAt, ...keys.map(key => row.data[key])])]
        .map(row => row.map(escape).join(',')).join('\r\n');
}
