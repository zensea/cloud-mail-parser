import { describe, it, expect } from 'vitest';
import { validateConditions, matchEmail } from '../src/lib/parser-matcher';

const condition = (source, value, operator = 'equals', extra = {}) => ({ source, value, operator, ...extra });

describe('parser admission conditions', () => {
    it('accepts all mail when conditions are omitted or empty', () => {
        expect(matchEmail(undefined, {}).matched).toBe(true);
        expect(matchEmail([], {}).matched).toBe(true);
    });
    it('combines sender, delivered recipient, subject and plain body with AND', () => {
        const conditions = [condition('from', 'shop@example.test'), condition('to', 'orders@example.test'),
            condition('subject', '订单', 'contains'), condition('text', '取消', 'notContains')];
        const email = { send_email: 'SHOP@example.test', to_email: 'orders@example.test', subject: '新订单 A', text: '金额 20' };
        expect(matchEmail(conditions, email).matched).toBe(true);
        const rejected = matchEmail(conditions, { ...email, subject: '通知', text: '取消订单' }, true);
        expect(rejected.matched).toBe(false);
        expect(rejected.checks.map(check => check.matched)).toEqual([true, true, false, false]);
    });
    it('distinguishes exact addresses, domain suffixes, prefixes and excluded values', () => {
        expect(matchEmail([condition('from', 'shop@example.test')], { from: 'evil-shop@example.test' }).matched).toBe(false);
        expect(matchEmail([condition('from', '@example.test', 'endsWith')], { from: 'shop@example.test' }).matched).toBe(true);
        expect(matchEmail([condition('subject', '[order]', 'startsWith')], { subject: '[ORDER] A-100' }).matched).toBe(true);
        expect(matchEmail([condition('subject', 'newsletter', 'notEquals')], { subject: 'NEWSLETTER' }).matched).toBe(false);
    });
    it('honors explicit case sensitivity and treats literal regex characters as text', () => {
        expect(matchEmail([condition('subject', 'Order', 'contains', { caseSensitive: true })], { subject: 'ORDER' }).matched).toBe(false);
        expect(matchEmail([condition('subject', 'a.b', 'contains')], { subject: 'axb' }).matched).toBe(false);
    });
    it('keeps regex and literal comparisons consistent when sharing a case folding cache', () => {
        const conditions = [condition('subject', '^order [A-Z]+$', 'regex'), condition('subject', 'ORDER ABC')];
        expect(matchEmail(conditions, { subject: 'Order ABC' }).matched).toBe(true);
        expect(matchEmail(conditions.toReversed(), { subject: 'Order ABC' }).matched).toBe(true);
        expect(matchEmail([condition('text', '(a+)+$', 'regex')], { text: 'a'.repeat(20000) + '!' }).matched).toBe(false);
    });
    it.each(['(?<=x)y', '(a)\\1', '['])('rejects invalid or unsupported RE2 syntax: %s', value => {
        expect(() => validateConditions([condition('subject', value, 'regex')])).toThrow();
    });
    it.each([null, {}, Array(21).fill(condition('subject', 'A')), [condition('html', 'A')],
        [condition('subject', 'A', 'unknown')], [condition('subject', ' ')], [condition('subject', 42)],
        [condition('subject', 'a'.repeat(513))], [condition('subject', 'a'.repeat(257), 'regex')],
        [condition('subject', 'A', 'contains', { caseSensitive: 'false' })]].map(conditions => [conditions]))('rejects malformed conditions %j', conditions => {
        expect(() => validateConditions(conditions)).toThrow();
    });
    it('bounds condition payload and source length without silently truncating', () => {
        expect(() => validateConditions(Array.from({ length: 20 }, () => condition('text', '中'.repeat(500))))).toThrow(/size/);
        expect(() => matchEmail([condition('text', 'A', 'contains')], { text: '中'.repeat(50000) })).toThrow(/size/);
    });
});
