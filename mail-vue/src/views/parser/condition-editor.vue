<template>
  <section class="condition-editor" aria-labelledby="parser-conditions-heading">
    <div class="section-heading">
      <h3 id="parser-conditions-heading">{{ t('parser.matchConditions') }}</h3>
      <el-button :disabled="modelValue.length >= 20" @click="add">{{ t('parser.addCondition') }}</el-button>
    </div>
    <p class="help">{{ t('parser.matchHelp') }}</p>
    <p v-if="!modelValue.length" class="help">{{ t('parser.matchAll') }}</p>
    <article v-for="(condition, index) in modelValue" :key="index" class="condition-card">
      <div class="condition-fields">
        <div>
          <label :for="`condition-source-${index}`">{{ t('parser.matchSource') }}</label>
          <el-select :id="`condition-source-${index}`" v-model="condition.source">
            <el-option v-for="source in sources" :key="source" :value="source" :label="t(`parser.sources.${source}`)" />
          </el-select>
        </div>
        <div>
          <label :for="`condition-operator-${index}`">{{ t('parser.matchOperator') }}</label>
          <el-select :id="`condition-operator-${index}`" v-model="condition.operator">
            <el-option v-for="operator in operators" :key="operator" :value="operator" :label="t(`parser.matchOperators.${operator}`)" />
          </el-select>
        </div>
      </div>
      <label :for="`condition-value-${index}`">{{ t('parser.matchValue') }}</label>
      <el-input :id="`condition-value-${index}`" v-model="condition.value" :maxlength="condition.operator === 'regex' ? 256 : 512" />
      <div class="condition-actions">
        <el-checkbox v-model="condition.caseSensitive">{{ t('parser.caseSensitive') }}</el-checkbox>
        <el-button size="small" @click="remove(index)">{{ t('parser.remove') }}</el-button>
      </div>
    </article>
  </section>
</template>
<script setup>
import { useI18n } from 'vue-i18n';
const props = defineProps({ modelValue: { type: Array, required: true } });
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();
const sources = ['from', 'to', 'subject', 'text'];
const operators = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex'];
function add() { emit('update:modelValue', [...props.modelValue, { source: 'subject', operator: 'contains', value: '', caseSensitive: false }]); }
function remove(index) { emit('update:modelValue', props.modelValue.filter((_, item) => item !== index)); }
</script>
<style scoped>
.condition-editor { margin: 8px 0 28px; }
.section-heading, .condition-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { font-size: 16px; font-weight: 600; }
.help { color: var(--el-text-color-secondary); font-size: 13px; margin: 10px 0 16px; }
.condition-card { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 14px; margin-top: 12px; }
.condition-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: block; font-size: 13px; margin: 0 0 6px; }
.condition-card > label { margin-top: 12px; }
.condition-actions { margin-top: 10px; }
@media (max-width: 600px) { .condition-fields { grid-template-columns: 1fr; } }
</style>
