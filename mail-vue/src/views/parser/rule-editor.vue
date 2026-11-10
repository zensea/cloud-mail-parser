<template>
  <section class="rule-editor" aria-labelledby="parser-fields-heading">
    <div class="section-heading">
      <h3 id="parser-fields-heading">{{ t('parser.fields') }}</h3>
      <el-button :disabled="modelValue.length >= 30" @click="addField">{{ t('parser.addField') }}</el-button>
    </div>
    <p class="help">{{ t('parser.ruleHelp') }}</p>
    <article v-for="(rule, index) in modelValue" :key="index" class="field-card">
      <div class="field-heading">
        <span class="field-number">{{ String(index + 1).padStart(2, '0') }}</span>
        <el-button size="small" :disabled="modelValue.length === 1" @click="removeField(index)">{{ t('parser.remove') }}</el-button>
      </div>
      <div class="field-options">
        <div>
          <label :for="`field-key-${index}`">{{ t('parser.fieldKey') }}</label>
          <el-input :id="`field-key-${index}`" v-model="rule.key" maxlength="64" />
        </div>
        <div>
          <label :for="`field-source-${index}`">{{ t('parser.source') }}</label>
          <el-select :id="`field-source-${index}`" v-model="rule.source" @change="resetSource(rule)">
            <el-option v-for="source in sources" :key="source" :value="source" :label="t(`parser.sources.${source}`)" />
          </el-select>
        </div>
        <el-checkbox v-model="rule.required">{{ t('parser.required') }}</el-checkbox>
      </div>
      <div v-if="isTable(rule)" class="table-options">
        <label v-if="rule.source === 'htmlTable'">{{ t('parser.tableIndex') }}
          <el-input-number v-model="rule.options.tableIndex" :min="1" :max="20" :aria-label="t('parser.tableIndex')" />
        </label>
        <template v-else>
          <label>{{ t('parser.attachmentName') }}
            <el-select v-model="rule.options.attachmentName" filterable allow-create default-first-option :aria-label="t('parser.attachmentName')">
              <el-option v-for="name in attachmentNames" :key="name" :value="name" :label="name" />
            </el-select>
          </label>
          <label>{{ t('parser.delimiter') }}
            <el-select v-model="rule.options.delimiter" :aria-label="t('parser.delimiter')">
              <el-option v-for="(label, value) in delimiters" :key="value" :value="value" :label="t(label)" />
            </el-select>
          </label>
        </template>
        <el-checkbox v-model="rule.options.hasHeader">{{ t('parser.hasHeader') }}</el-checkbox>
        <p class="help">{{ t('parser.tableHelp') }}</p>
      </div>
      <ol class="filters">
        <li v-for="(filter, step) in rule.filters" :key="step" class="filter">
          <div class="filter-heading">
            <el-select v-model="filter.type" :aria-label="t('parser.filters')" @change="resetFilter(rule, step, $event)">
              <el-option v-for="type in isTable(rule) ? tableTypes : types" :key="type" :value="type" :label="t(`parser.types.${type}`)" />
            </el-select>
            <div class="step-actions">
              <el-button size="small" :disabled="step === 0" @click="move(rule.filters, step, -1)">{{ t('parser.moveUp') }}</el-button>
              <el-button size="small" :disabled="step === rule.filters.length - 1" @click="move(rule.filters, step, 1)">{{ t('parser.moveDown') }}</el-button>
              <el-button size="small" @click="rule.filters.splice(step, 1)">{{ t('parser.remove') }}</el-button>
            </div>
          </div>
          <div v-if="filter.type === 'between'" class="filter-inputs">
            <el-input v-model="filter.start" :aria-label="t('parser.start')" :placeholder="t('parser.start')" maxlength="512" />
            <el-input v-model="filter.end" :aria-label="t('parser.end')" :placeholder="t('parser.end')" maxlength="512" />
          </div>
          <template v-else-if="filter.type === 'regex'">
            <el-input v-model="filter.pattern" :aria-label="t('parser.pattern')" :placeholder="t('parser.pattern')" maxlength="256" />
            <div class="filter-inputs regex-options">
              <label>{{ t('parser.group') }} <el-input-number v-model="filter.group" :min="0" :max="30" :aria-label="t('parser.group')" /></label>
              <label>{{ t('parser.flags') }}
                <el-select v-model="filter.flags" :aria-label="t('parser.flags')">
                  <el-option v-for="flags in ['', 'i', 'm', 's', 'im', 'ims']" :key="flags" :value="flags" :label="flags || '—'" />
                </el-select>
              </label>
            </div>
          </template>
          <div v-else-if="filter.type === 'replace'" class="filter-inputs">
            <el-input v-model="filter.search" :aria-label="t('parser.search')" :placeholder="t('parser.search')" maxlength="512" />
            <el-input v-model="filter.replacement" :aria-label="t('parser.replacement')" :placeholder="t('parser.replacement')" maxlength="512" />
          </div>
          <el-input v-else-if="filter.type === 'default'" v-model="filter.value" :aria-label="t('parser.defaultValue')" :placeholder="t('parser.defaultValue')" maxlength="512" />
          <el-select v-else-if="filter.type === 'date'" v-model="filter.inputFormat" :aria-label="t('parser.dateFormat')">
            <el-option v-for="format in ['YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY']" :key="format" :value="format" :label="format" />
          </el-select>
          <div v-else-if="filter.type === 'tableRows'" class="filter-inputs regex-options">
            <label>{{ t('parser.rowStart') }} <el-input-number v-model="filter.start" :min="1" :max="200" :aria-label="t('parser.rowStart')" /></label>
            <label>{{ t('parser.rowEnd') }} <el-input-number v-model="filter.end" :min="filter.start" :max="200" :aria-label="t('parser.rowEnd')" /></label>
          </div>
          <el-select v-else-if="filter.type === 'tableColumns'" v-model="filter.columns" multiple filterable allow-create default-first-option :aria-label="t('parser.columnNames')" :placeholder="t('parser.columnNames')" />
        </li>
      </ol>
      <el-button size="small" :disabled="rule.filters.length >= 12" @click="rule.filters.push({ type: isTable(rule) ? 'tableTrim' : 'trim' })">{{ t('parser.addFilter') }}</el-button>
    </article>
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
const props = defineProps({ modelValue: { type: Array, required: true }, attachmentNames: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();
const sources = ['subject', 'text', 'htmlText', 'from', 'to', 'htmlTable', 'csvAttachment'];
const types = ['between', 'regex', 'replace', 'trim', 'collapse', 'lower', 'upper', 'default', 'number', 'date'];
const tableTypes = ['tableTrim', 'tableRows', 'tableColumns'];
const delimiters = { ',': 'parser.comma', ';': 'parser.semicolon', '\t': 'parser.tab' };
const isTable = rule => ['htmlTable', 'csvAttachment'].includes(rule.source);
function resetSource(rule) {
  if (isTable(rule)) {
    rule.options = { hasHeader: true, ...(rule.source === 'htmlTable' ? { tableIndex: 1 } : { attachmentName: props.attachmentNames[0] || 'orders.csv', delimiter: ',' }) };
    rule.filters = [{ type: 'tableTrim' }];
  } else {
    delete rule.options;
    if (rule.filters.some(filter => tableTypes.includes(filter.type))) rule.filters = [{ type: 'trim' }];
  }
}
function addField() {
  let number = props.modelValue.length + 1;
  while (props.modelValue.some(field => field.key === `field_${number}`)) number++;
  emit('update:modelValue', [...props.modelValue, { key: `field_${number}`, source: 'text', required: false, filters: [{ type: 'trim' }] }]);
}
function removeField(index) { emit('update:modelValue', props.modelValue.filter((_, item) => item !== index)); }
function move(filters, index, offset) { const [filter] = filters.splice(index, 1); filters.splice(index + offset, 0, filter); }
function resetFilter(rule, index, type) {
  const options = { between: { start: '', end: '' }, regex: { pattern: '', flags: 'm', group: 0 }, replace: { search: '', replacement: '' }, default: { value: '' }, date: { inputFormat: 'YYYY-MM-DD' }, tableRows: { start: 1, end: 200 }, tableColumns: { columns: [] } };
  rule.filters[index] = { type, ...options[type] };
}
</script>

<style scoped>
.section-heading, .field-heading, .filter-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { font-size: 16px; font-weight: 600; }
.help { margin: 10px 0 18px; color: var(--el-text-color-secondary); font-size: 13px; }
.field-card { margin-bottom: 16px; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.field-heading { margin-bottom: 12px; }
.field-number { font-size: 13px; color: var(--el-color-primary); font-weight: 600; }
.field-options { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(120px, 1fr) auto; align-items: end; gap: 12px; }
.field-options label { display: block; margin-bottom: 6px; font-size: 13px; }
.filters { margin: 16px 0 12px; }
.filter { padding: 12px; margin: 8px 0; background: var(--el-fill-color-light); border-radius: 6px; }
.filter-heading { margin-bottom: 10px; flex-wrap: wrap; }
.filter-heading > .el-select { width: 160px; }
.step-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.step-actions .el-button + .el-button { margin-left: 0; }
.filter-inputs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.regex-options { margin-top: 10px; }
.regex-options label { font-size: 12px; display: grid; gap: 6px; }
.regex-options .el-input-number { width: 100%; }
.table-options { display: grid; gap: 10px; margin-top: 16px; }
.table-options label { display: grid; gap: 6px; font-size: 13px; }
.table-options .help { margin: 0; }
@media (max-width: 600px) { .field-options { grid-template-columns: 1fr; } .filter-inputs { grid-template-columns: 1fr; } .field-card { padding: 12px; } }
</style>
