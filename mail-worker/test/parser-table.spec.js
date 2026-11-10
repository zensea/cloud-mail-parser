import { describe, it, expect } from 'vitest';
import { csvRows, htmlRows, tableRecords } from '../src/lib/parser-table';
import { parseEmail, validateRules, csvExport } from '../src/lib/parser-engine';

const table = (source = 'csvAttachment', options = {}, filters = []) => [{ key: 'items', source, required: true,
    options: { hasHeader: true, ...(source === 'htmlTable' ? { tableIndex: 1 } : { attachmentName: 'orders.csv', delimiter: ',' }), ...options }, filters }];
const sample = text => ({ attachments: [{ name: 'orders.csv', text }] });

describe('bounded table extraction', () => {
    it('reads BOM, quoted delimiters, escaped quotes, newlines, CRLF and trailing empty cells', () => {
        expect(csvRows('\uFEFFname,note,extra\r\n"A,B","say ""yes""\nnext",\r\n')).toEqual([
            ['name', 'note', 'extra'], ['A,B', 'say "yes"\nnext', '']]);
    });
    it.each(['a,b\n"broken,b', 'a,b\nx"y,z', 'a,b\n"x"tail,z'])('rejects malformed quotes: %s', text => {
        expect(() => csvRows(text)).toThrow();
    });
    it('supports alternate delimiters and headerless input', () => {
        expect(csvRows('value\n""\n\n')).toEqual([['value'], ['']]);
        expect(parseEmail(table('csvAttachment', { delimiter: ';', hasHeader: false }), sample('苹果;2\n梨;3')).data.items)
            .toEqual([{ column_1: '苹果', column_2: '2' }, { column_1: '梨', column_2: '3' }]);
        expect(csvRows('a\tb\n1\t2', '\t')[1]).toEqual(['1', '2']);
    });
    it('normalizes blank, repeated and reserved headers without overwriting values', () => {
        expect(tableRecords([['__proto__', 'x', 'x', '', 'x_2'], ['a', 'b', 'c', 'd', 'e']])[0])
            .toEqual({ column_1: 'a', x: 'b', x_2: 'c', column_4: 'd', x_2_2: 'e' });
        expect(Object.keys(tableRecords([['a'.repeat(128), 'a'.repeat(128)], ['1', '2']])[0]).every(key => key.length <= 128)).toBe(true);
    });
    it('rejects ragged rows, excessive rows, columns and cells without silent truncation', () => {
        expect(() => tableRecords(csvRows('a,b\n1'))).toThrow(/inconsistent/);
        expect(() => csvRows(Array(203).fill('a').join('\n'))).toThrow(/200/);
        expect(() => csvRows(Array(51).fill('a').join(','))).toThrow(/50/);
        expect(() => csvRows('a'.repeat(8193))).toThrow(/8192/);
        expect(() => tableRecords(Array(201).fill(['a']), false)).toThrow(/200/);
    });
    it('extracts only the selected HTML table and excludes nested tables and scripts', () => {
        const html = '<table><tr><th>item</th><th>qty</th></tr><tr><td> 苹果 <script>secret()</script><table><tr><td>nested</td></tr></table></td><td>2</td></tr></table><table><tr><th>code</th></tr><tr><td>B</td></tr></table>';
        expect(parseEmail(table('htmlTable', {}, [{ type: 'tableTrim' }]), { html }).data.items).toEqual([{ item: '苹果', qty: '2' }]);
        expect(parseEmail(table('htmlTable', { tableIndex: 3 }), { html }).data.items).toEqual([{ code: 'B' }]);
        expect(htmlRows(html, 4)).toEqual([]);
    });
    it('rejects merged HTML cells instead of shifting column values', () => {
        expect(() => htmlRows('<table><tr><td colspan="2">x</td></tr></table>')).toThrow(/Merged/);
    });
    it('applies row, column and trim operations in order and records structured trace values', () => {
        const filters = [{ type: 'tableRows', start: 2, end: 2 }, { type: 'tableColumns', columns: ['item'] }, { type: 'tableTrim' }];
        const result = parseEmail(table('csvAttachment', {}, filters), sample('item,qty\nA,1\n B ,2\nC,3'), true);
        expect(result.data.items).toEqual([{ item: 'B' }]);
        expect(result.fields[0].steps[0].value).toHaveLength(3);
        expect(result.fields[0].steps.at(-1).value).toEqual([{ item: 'B' }]);
        expect(result.errors).toEqual([]);
    });
    it('reports required empty tables, duplicate files and unknown selected columns', () => {
        expect(parseEmail(table(), {}).errors[0].message).toContain('empty');
        expect(parseEmail(table(), { attachments: [...sample('x\n1').attachments, ...sample('x\n2').attachments] }).errors[0].message).toContain('ambiguous');
        expect(parseEmail(table('csvAttachment', {}, [{ type: 'tableColumns', columns: ['missing'] }]), sample('x\n1')).errors[0].message).toContain('column');
    });
    it('validates source-specific options, steps, ranges and file limits', () => {
        expect(() => validateRules(table('htmlTable', { tableIndex: 0 }))).toThrow();
        expect(() => validateRules(table('csvAttachment', { delimiter: '|' }))).toThrow();
        expect(() => validateRules(table('csvAttachment', { attachmentName: 'secret.pdf' }))).toThrow();
        expect(() => validateRules(table('csvAttachment', {}, [{ type: 'trim' }]))).toThrow();
        expect(() => validateRules(table('csvAttachment', {}, [{ type: 'tableRows', start: 5, end: 2 }]))).toThrow();
        expect(() => validateRules(Array.from({ length: 6 }, (_, index) => ({ ...table()[0], key: `file_${index}`, options: { ...table()[0].options, attachmentName: `file_${index}.csv` } })))).toThrow(/5 CSV/);
        expect(() => parseEmail(table(), sample('中'.repeat(22000)))).toThrow(/size/);
    });
});

describe('table exports', () => {
    const rows = [{ id: 7, emailId: 9, version: 2, parsedAt: 1000, data: { customer: 'Demo', items: [{ sku: 'A', qty: '2' }, { sku: '=evil()', qty: '3' }] } }];
    it('preserves nested data as JSON in per-email CSV', () => {
        expect(csvExport(rows)).toContain('[{""sku"":""A""');
    });
    it('flattens the selected table and repeats source identifiers and scalar fields', () => {
        const csv = csvExport(rows, 'items');
        expect(csv).toContain('"items.sku","items.qty"');
        expect(csv).toContain('"7","9","2","1000","Demo","A","2"');
        expect(csv).toContain('"Demo","\'=evil()","3"');
        expect(csv.split('\r\n')).toHaveLength(3);
    });
    it('rejects an output batch exceeding 4 MiB', () => {
        const large = [{ ...rows[0], data: { text: 'x'.repeat(30000), items: Array(200).fill({ sku: 'A' }) } }];
        expect(() => csvExport(large, 'items')).toThrow(/4 MiB/);
    });
});
