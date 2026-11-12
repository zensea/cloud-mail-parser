import BizError from '../error/biz-error';

export function exportOptions(params) {
    const tableField = params.tableField ?? '';
    const key = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
    if (typeof tableField !== 'string' || (tableField && !key.test(tableField))) throw new BizError('Invalid table export field', 400);
    let fields = params.fields ?? [];
    if (typeof fields === 'string') fields = fields ? fields.split(',') : [];
    if (!Array.isArray(fields) || fields.length > 30 || fields.some(field => typeof field !== 'string' || !key.test(field)) || new Set(fields).size !== fields.length) {
        throw new BizError('Select up to 30 distinct export fields', 400);
    }
    if (tableField && fields.length && !fields.includes(tableField)) throw new BizError('Include the selected table in export fields', 400);
    const time = value => {
        if (value === undefined || value === null || value === '') return 0;
        if (!['string', 'number'].includes(typeof value) || !/^\d{1,16}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new BizError('Invalid export time', 400);
        return Number(value);
    };
    const fromTime = time(params.fromTime), toTime = time(params.toTime);
    if (toTime && toTime < fromTime) throw new BizError('Export end time precedes start time', 400);
    const size = params.size === undefined ? (tableField ? 10 : 100) : Number(params.size);
    if (!['undefined', 'string', 'number'].includes(typeof params.size) || !Number.isSafeInteger(size) || size < 1) throw new BizError('Invalid export batch size', 400);
    return { tableField, fields, fromTime, toTime, size: Math.min(tableField ? 10 : 100, size) };
}

export function downloadOptions(params) {
    const range = params.range ?? 'latest100';
    if (!['latest1', 'latest100', 'latest1000', 'today', 'last7days', 'all', 'custom', 'legacy'].includes(range)) throw new BizError('Invalid download range', 400);
    const offset = params.timezoneOffset ?? 0, timezoneOffset = Number(offset);
    if (!['number', 'string'].includes(typeof offset) || !/^-?\d{1,4}$/.test(String(offset)) || !Number.isInteger(timezoneOffset) || timezoneOffset < -840 || timezoneOffset > 840) throw new BizError('Invalid download timezone', 400);
    const options = exportOptions(params);
    if (range === 'custom' && (!options.fromTime || !options.toTime)) throw new BizError('Choose a start and end time', 400);
    return { ...options, range, timezoneOffset };
}

export function downloadWindow(options, now = Date.now()) {
    const latest = /^latest(\d+)$/.exec(options.range);
    let fromTime = ['custom', 'legacy'].includes(options.range) ? options.fromTime : 0;
    let toTime = ['custom', 'legacy'].includes(options.range) && options.toTime ? Math.min(options.toTime, now) : now;
    if (options.range === 'last7days') fromTime = now - 7 * 86400000;
    if (options.range === 'today') {
        const local = new Date(now - options.timezoneOffset * 60000);
        fromTime = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + options.timezoneOffset * 60000;
    }
    return { fromTime, toTime, limit: latest ? Number(latest[1]) : 1000, limited: !!latest };
}
