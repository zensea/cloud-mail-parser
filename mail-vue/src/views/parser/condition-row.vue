<template>
  <article class="condition-card">
    <div class="condition-fields">
      <div>
        <label :for="`condition-source-${index}`">{{ t('parser.matchSource') }}</label>
        <el-select :id="`condition-source-${index}`" v-model="condition.source">
          <el-option v-for="source in sources" :key="source" :value="source" :label="source === 'to' ? t('parser.deliveryAddress') : t(`parser.sources.${source}`)" />
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
      <el-button size="small" @click="$emit('remove')">{{ t('parser.remove') }}</el-button>
    </div>
  </article>
</template>
<script setup>
import { useI18n } from 'vue-i18n';
defineProps({ condition: { type: Object, required: true }, index: { type: Number, required: true }, sources: { type: Array, required: true } });
defineEmits(['remove']);
const { t } = useI18n();
const operators = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex'];
</script>
<style scoped>
.condition-card { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 14px; margin-top: 12px; }
.condition-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: block; font-size: 13px; margin: 0 0 6px; }
.condition-card > label { margin-top: 12px; }
.condition-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
@media (max-width: 600px) { .condition-fields { grid-template-columns: 1fr; } }
</style>
