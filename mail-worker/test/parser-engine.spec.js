import { describe, it, expect } from 'vitest';
import { parseEmail, validateRules, csvExport, emailInput } from '../src/lib/parser-engine';

const field = (filters, options = {}) => [{ key: 'value', source: 'text', required: true, filters, ...options }];

describe('email parsing engine', () => {
    it('extracts Chinese multiline fields and records intermediate values', () => {
        const result = parseEmail(field([{ type: 'between', start: '金额：', end: '\n' }, { type: 'trim' },
            { type: 'replace', search: '¥', replacement: '' }, { type: 'number' }]), { text: '订单\n金额： ¥128.50\n客户：张三' }, true);
        expect(result.data.value).toBe(128.5);
        expect(result.errors).toEqual([]);
        expect(result.fields[0].steps).toHaveLength(5);
    });

    it('extracts regex groups with supported flags', () => {
        expect(parseEmail(field([{ type: 'regex', pattern: '^code: ([a-z0-9]+)$', flags: 'im', group: 1 }]), { text: 'other\nCODE: Ab123\n' }).data.value).toBe('Ab123');
    });

    it('handles nested repetitions without a backtracking engine', () => {
        const result = parseEmail(field([{ type: 'regex', pattern: '(a+)+$', group: 0 }]), { text: 'a'.repeat(20000) + '!' });
        expect(result.errors[0].message).toContain('empty');
    });

    it.each(['(?<=x)y', '(a)\\1', '['])('rejects unsupported or invalid patterns: %s', pattern => {
        expect(() => validateRules(field([{ type: 'regex', pattern }]))).toThrow();
    });

    it('does not treat a missing end marker as a successful extraction', () => {
        expect(parseEmail(field([{ type: 'between', start: 'start', end: 'missing' }]), { text: 'start confidential tail' }).data.value).toBeNull();
    });

    it('supports optional missing fields and explicit defaults', () => {
        expect(parseEmail(field([{ type: 'regex', pattern: 'not-present' }], { required: false }), { text: 'hello' }).data.value).toBe('');
        expect(parseEmail(field([{ type: 'default', value: 'unknown' }]), {}).data.value).toBe('unknown');
    });

    it('extracts text from HTML without script content', () => {
        const result = parseEmail(field([{ type: 'collapse' }], { source: 'htmlText' }), { html: '<p>张三</p><script>secret()</script><p>订单</p>' });
        expect(result.data.value).toContain('张三');
        expect(result.data.value).not.toContain('secret');
    });

    it('keeps zero and validates numeric values', () => {
        expect(parseEmail(field([{ type: 'number' }]), { text: '0' }).data.value).toBe(0);
        expect(parseEmail(field([{ type: 'number' }]), { text: '12 dollars' }).errors).toHaveLength(1);
    });

    it('converts dates deterministically and rejects impossible dates', () => {
        expect(parseEmail(field([{ type: 'date', inputFormat: 'DD/MM/YYYY' }]), { text: '29/02/2024' }).data.value).toBe('2024-02-29');
        expect(parseEmail(field([{ type: 'date', inputFormat: 'YYYY-MM-DD' }]), { text: '2025-02-29' }).errors).toHaveLength(1);
        expect(parseEmail(field([{ type: 'date', inputFormat: 'YYYY-MM-DD' }]), { text: '2024/02-29' }).errors).toHaveLength(1);
    });

    it('rejects duplicate field names and prototype-related keys', () => {
        expect(() => validateRules([...field([]), ...field([])])).toThrow();
        expect(() => validateRules(field([], { key: '__proto__' }))).toThrow();
        expect(() => validateRules(field([], { key: ['value'] }))).toThrow();
    });

    it('enforces input and output bounds without truncating values', () => {
        expect(() => emailInput({ text: '中'.repeat(50000) })).toThrow(/size/);
        expect(parseEmail(field([]), { text: 'a'.repeat(9000) }).errors).toHaveLength(1);
    });

    it('quotes CSV and neutralizes spreadsheet formulas', () => {
        const csv = csvExport([{ id: 1, emailId: 2, version: 1, parsedAt: 1, data: { value: ' =SUM(1,2)', label: 'a"b\nc' } }]);
        expect(csv).toContain('"\' =SUM(1,2)"');
        expect(csv).toContain('"a""b\nc"');
        expect(csv.startsWith('\uFEFF')).toBe(true);
    });

    it('bounds preview trace size even when many fields reuse a large source', () => {
        const rules = Array.from({ length: 30 }, (_, index) => ({ key: `field_${index}`, source: 'text', filters: Array.from({ length: 12 }, () => ({ type: 'trim' })) }));
        expect(() => parseEmail(rules, { text: 'a'.repeat(7500) }, true)).toThrow(/size limit/);
    });
});
