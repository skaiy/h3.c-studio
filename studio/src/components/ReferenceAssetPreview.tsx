import { useState } from 'react'
import type { ReferenceAsset } from '@/lib/api'
import { useI18n } from '@/lib/useI18n'

interface Props {
  asset: ReferenceAsset
  repairHint?: boolean
}

export default function ReferenceAssetPreview(props: Props) {
  // Only a different media source resets a load failure, not a metadata poll.
  return <Preview key={`${props.asset.kind}/${props.asset.filename}`} {...props} />
}

function Preview({ asset, repairHint }: Props) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  if (asset.missing || failed) {
    return <p className="text-amber-300">{t('referenceMissing')}{repairHint && ` · ${t('referenceRepairHint')}`}</p>
  }
  // Managed references (including frozen snapshots) are local files in UPLOADS.
  const src = `/uploads/${encodeURIComponent(asset.filename)}`
  return asset.kind === 'image'
    ? <img src={src} alt={asset.filename} loading="lazy" onError={() => setFailed(true)}
        className="mt-1 h-20 w-28 max-w-full border border-border object-contain" />
    : <audio src={src} aria-label={asset.filename} controls preload="none" onError={() => setFailed(true)}
        className="mt-1 block w-full min-w-0 max-w-full" />
}