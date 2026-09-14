import { createContext, useContext, useState, type ReactNode } from 'react'
import { VALID_LANGS, type I18nKey, type Lang } from '@/lib/i18nData'
import { translate } from '@/lib/i18nResources'

export type { Lang, I18nKey }

interface I18nCtx {
  lang: Lang
  t: (k: I18nKey) => string
  setLang: (l: Lang) => void
}

const Ctx = createContext<I18nCtx>({ lang: 'zh', t: (k) => translate('zh', k), setLang: () => {} })

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
  return <Ctx.Provider value={{ lang, t: (k) => translate(lang, k), setLang }}>{children}</Ctx.Provider>
}

export const useI18n = () => useContext(Ctx)
