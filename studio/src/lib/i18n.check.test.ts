import { describe, expect, it } from 'vitest'
import { LANGS } from '@/lib/i18nData'
import { resources } from '@/lib/i18nResources'

describe('i18n key parity (npm run i18n:check)', () => {
  const canonicalKeys = Object.keys(resources.zh).sort()

  it('has the five languages the settings sheet offers', () => {
    expect(LANGS.map((l) => l.code).sort()).toEqual(['de', 'en', 'ja', 'ko', 'zh'])
  })

  it('zh is non-empty (it is the canonical dictionary every other language is checked against)', () => {
    expect(canonicalKeys.length).toBeGreaterThan(0)
  })

  for (const { code } of LANGS) {
    it(`"${code}" has every key zh has, with no empty values`, () => {
      const keys = Object.keys(resources[code]).sort()
      expect(keys).toEqual(canonicalKeys)
      for (const key of canonicalKeys) {
        expect(resources[code][key as keyof typeof resources.zh], `${code}.${key}`).toBeTruthy()
      }
    })
  }
})
