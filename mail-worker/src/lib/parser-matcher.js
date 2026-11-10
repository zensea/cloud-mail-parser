import { RE2JS } from 're2js';
import { checkSize } from './parser-engine';

const SOURCES = ['from', 'to', 'subject', 'text'];
const OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex'];

function pattern(condition) {
    return RE2JS.compile(condition.value, condition.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
}

export function validateConditions(conditions = []) {
    checkSize(conditions, 16384);
    if (!Array.isArray(conditions) || conditions.length > 20) throw new Error('Use at most 20 matching conditions');
    return conditions.map(condition => {
        if (!condition || !SOURCES.includes(condition.source) || !OPERATORS.includes(condition.operator)) throw new Error('Invalid matching condition');
        if (typeof condition.value !== 'string' || !condition.value.trim() || condition.value.length > (condition.operator === 'regex' ? 256 : 512)) throw new Error('Invalid matching value; use 1 to 512 characters, or 256 for regex');
        if (condition.caseSensitive !== undefined && typeof condition.caseSensitive !== 'boolean') throw new Error('Case sensitivity must be a boolean');
        const normalized = { source: condition.source, operator: condition.operator, value: condition.value, caseSensitive: condition.caseSensitive ?? false };
        if (condition.operator === 'regex') pattern(normalized);
        return normalized;
    });
}

// Also accepts database rows so non-matching mail never needs attachment reads.
export function matchEmail(conditions, email, trace = false) {
    const normalized = validateConditions(conditions);
    const sources = {
        from: email.from ?? email.send_email ?? email.sendEmail ?? '',
        to: email.to ?? email.to_email ?? email.toEmail ?? '',
        subject: email.subject ?? '', text: email.text ?? ''
    };
    const checks = [];
    const cache = new Map();
    for (const [index, condition] of normalized.entries()) {
        const key = condition.source;
        if (!cache.has(key)) {
            const source = String(sources[condition.source]);
            checkSize(source);
            cache.set(key, { raw: source, folded: source.toLowerCase() });
        }
        // RE2 handles its own case folding; literal comparisons use normalized text.
        const value = condition.operator === 'regex' || condition.caseSensitive ? cache.get(key).raw : cache.get(key).folded;
        const expected = condition.caseSensitive ? condition.value : condition.value.toLowerCase();
        const matched = {
            equals: () => value === expected,
            notEquals: () => value !== expected,
            contains: () => value.includes(expected),
            notContains: () => !value.includes(expected),
            startsWith: () => value.startsWith(expected),
            endsWith: () => value.endsWith(expected),
            regex: () => pattern(condition).matcher(value).find()
        }[condition.operator]();
        checks.push({ index, source: condition.source, operator: condition.operator, matched });
        if (!matched && !trace) break;
    }
    return { matched: checks.every(check => check.matched), checks };
}
