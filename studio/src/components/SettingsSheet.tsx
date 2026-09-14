import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { LANGS, type Lang } from '@/lib/i18nData'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'

const STUDIO_VERSION = 'v0.2'
const GITHUB_URL = 'https://github.com/skaiy/h3.c-studio'

/** Config registry: each entry declares a section + the field type it renders. Add more here in later phases. */
type SettingsSection = { id: string; titleKey: 'settingsLanguage' | 'settingsAbout'; type: 'language' | 'about' }
const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'language', titleKey: 'settingsLanguage', type: 'language' },
  { id: 'about', titleKey: 'settingsAbout', type: 'about' },
]

function LanguageField() {
  const { lang, setLang } = useI18n()
  return (
    <RadioGroup value={lang} onValueChange={(v) => setLang(v as Lang)} className="gap-2">
      {LANGS.map((l) => (
        <div key={l.code} className="flex items-center gap-2">
          <RadioGroupItem value={l.code} id={`lang-${l.code}`} />
          <Label htmlFor={`lang-${l.code}`} className="text-[13px] cursor-pointer">{l.label}</Label>
        </div>
      ))}
    </RadioGroup>
  )
}

function AboutField() {
  const { t } = useI18n()
  const [engineVersion, setEngineVersion] = useState('…')
  useEffect(() => {
    api.info().then((r) => setEngineVersion(r.info.split('\n')[0]?.trim() || '—')).catch(() => setEngineVersion('—'))
  }, [])
  return (
    <div className="flex flex-col gap-2 text-[12px] mono">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">{t('studioVersion')}</span>
        <span>{STUDIO_VERSION}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">{t('engineVersion')}</span>
        <span>{engineVersion}</span>
      </div>
      <a href={GITHUB_URL} target="_blank" rel="noreferrer"
        className="text-muted-foreground hover:text-white underline underline-offset-2 mt-1">
        {t('githubLink')} ↗
      </a>
    </div>
  )
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function SettingsSheet({ open, onOpenChange }: Props) {
  const { t } = useI18n()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:max-w-none rounded-none bg-background border-border">
        <SheetHeader>
          <SheetTitle className="bar !h-auto !px-0">{t('settingsTitle')}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          {SETTINGS_SECTIONS.map((section) => (
            <div key={section.id}>
              <div className="bar !px-0">{t(section.titleKey)}</div>
              <div className="pt-2">
                {section.type === 'language' ? <LanguageField /> : <AboutField />}
              </div>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
