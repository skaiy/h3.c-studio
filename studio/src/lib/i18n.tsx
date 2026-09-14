import { useState, type ReactNode } from 'react'
import { VALID_LANGS, type I18nKey, type Lang } from '@/lib/i18nData'
import { translate } from '@/lib/i18nResources'
import { I18nContext } from '@/lib/i18nContext'

export type { Lang, I18nKey }

const STORAGE_KEY = 'h3-studio-lang'

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Lang | null
    return stored && VALID_LANGS.includes(stored) ? stored : 'zh'
  })
  const setLang = (l: Lang) => {
    setLangState(l)
    localStorage.setItem(STORAGE_KEY, l)
  }
  return <I18nContext.Provider value={{ lang, t: (k) => translate(lang, k), setLang }}>{children}</I18nContext.Provider>
}
