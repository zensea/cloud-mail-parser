import { createI18n } from 'vue-i18n';
import en from './en.js'
import zh from './zh.js'
import { parserZh, parserEn } from './parser.js'
const i18n = createI18n({
    legacy: false,
    messages: {
        zh: { ...zh, parser: parserZh },
        en: { ...en, parser: parserEn }
    },
});

export default i18n;
