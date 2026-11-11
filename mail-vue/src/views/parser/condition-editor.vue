<template>
  <section class="condition-editor" aria-labelledby="parser-conditions-heading">
    <div class="section-heading">
      <h3 id="parser-conditions-heading">{{ t('parser.matchConditions') }}</h3>
      <el-button :disabled="modelValue.length >= 20" @click="add()">{{ t('parser.addCondition') }}</el-button>
    </div>
    <p class="help">{{ t('parser.matchHelp') }}</p>
    <p v-if="!modelValue.length" class="help">{{ t('parser.matchAll') }}</p>
    <condition-row v-for="row in regularConditions" :key="row.index" :condition="row.condition" :index="row.index" :sources="regularSources" @remove="remove(row.index)" />
    <el-collapse v-model="advancedOpen" class="advanced-conditions">
      <el-collapse-item :title="t('parser.advancedConditions', { count: advancedConditions.length })" name="delivery">
        <p class="help">{{ t('parser.deliveryAddressHelp') }}</p>
        <condition-row v-for="row in advancedConditions" :key="row.index" :condition="row.condition" :index="row.index" :sources="[...regularSources, 'to']" @remove="remove(row.index)" />
        <el-button class="add-delivery" :disabled="modelValue.length >= 20" @click="add('to')">{{ t('parser.addDeliveryCondition') }}</el-button>
      </el-collapse-item>
    </el-collapse>
  </section>
</template>
<script setup>
import { useI18n } from 'vue-i18n';
import { computed, ref, watch } from 'vue';
import ConditionRow from './condition-row.vue';
const props = defineProps({ modelValue: { type: Array, required: true } });
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();
const regularSources = ['from', 'subject', 'text'];
const indexedConditions = computed(() => props.modelValue.map((condition, index) => ({ condition, index })));
const regularConditions = computed(() => indexedConditions.value.filter(row => row.condition.source !== 'to'));
const advancedConditions = computed(() => indexedConditions.value.filter(row => row.condition.source === 'to'));
const advancedOpen = ref([]);
watch(advancedConditions, (rows, previous = []) => {
  if (rows.some(row => !previous.some(old => old.condition === row.condition))) advancedOpen.value = ['delivery'];
  else if (!rows.length && previous.length) advancedOpen.value = [];
}, { immediate: true });
function add(source = 'subject') {
  if (props.modelValue.length >= 20) return;
  emit('update:modelValue', [...props.modelValue, { source, operator: source === 'to' ? 'equals' : 'contains', value: '', caseSensitive: false }]);
}
function remove(index) { emit('update:modelValue', props.modelValue.filter((_, item) => item !== index)); }
</script>
<style scoped>
.condition-editor { margin: 8px 0 28px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3 { font-size: 16px; font-weight: 600; }
.help { color: var(--el-text-color-secondary); font-size: 13px; margin: 10px 0 16px; }
.advanced-conditions { margin-top: 16px; }
.add-delivery { margin-top: 14px; }
</style>
