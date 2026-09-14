import { createContext } from 'react'
import { type I18nKey, type Lang } from '@/lib/i18nData'
import { translate } from '@/lib/i18nResources'

export interface I18nCtx {
  lang: Lang
  t: (k: I18nKey) => string
  setLang: (l: Lang) => void
}

export const I18nContext = createContext<I18nCtx>({
  lang: 'zh',
  t: (k) => translate('zh', k),
  setLang: () => {},
})
