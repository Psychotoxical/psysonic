import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { deTranslation } from './locales/de';
import { enTranslation } from './locales/en';
import { frTranslation } from './locales/fr';
import { zhTranslation } from './locales/zh';
import { nbTranslation } from './locales/nb';
import { ruTranslation } from './locales/ru';
import { nlTranslation } from './locales/nl';
import { esTranslation } from './locales/es';
import { roTranslation } from './locales/ro';
import { jaTranslation } from './locales/ja';

const savedLanguage = localStorage.getItem('psysonic_language') || 'en';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: enTranslation },
      de: { translation: deTranslation },
      es: { translation: esTranslation },
      fr: { translation: frTranslation },
      nl: { translation: nlTranslation },
      zh: { translation: zhTranslation },
      nb: { translation: nbTranslation },
      ru: { translation: ruTranslation },
      ro: { translation: roTranslation },
      ja: { translation: jaTranslation },
    },
    lng: savedLanguage,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

i18n.on('languageChanged', lng => {
  localStorage.setItem('psysonic_language', lng);
});

export default i18n;
