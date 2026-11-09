import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import de from './de.json';
import en from './en.json';

export const LANGUAGES = ['en', 'de'] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, de: { translation: de } },
    fallbackLng: 'en',
    supportedLngs: ['en', 'de'],
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    interpolation: { escapeValue: false },

    detection: {
      order: ['localStorage'],
      lookupLocalStorage: 'processpoll:lang',
      caches: ['localStorage'],
    },
  });

function syncHtmlLang(lng: string) {
  try {
    document.documentElement.lang = lng.startsWith('de') ? 'de' : 'en';
  } catch {
    return;
  }
}
syncHtmlLang(i18n.language || 'en');
i18n.on('languageChanged', syncHtmlLang);

export default i18n;
