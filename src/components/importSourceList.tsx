import { clientIntegrations } from '@/integrations'
import { AppIcon } from './ui/brand-mark'
import type { ImportSource } from './ImportSources'
import { t as translate, type Translate } from '@/lib/i18n'
import { isLean } from '@/lib/lean'

/** The sources the import picker offers, in order — the canvas page's modal
 *  and Home's Import button show the same list, so it lives once. Lean mode
 *  turns integrations and GitHub import off, leaving the website and the live app. */
export function importSources(t: Translate = translate, lean: boolean = isLean()): ImportSource[] {
  const sources: ImportSource[] = [
    {
      id: 'website',
      title: t('panels.importWebsite'),
      blurb: t('panels.importWebsiteBlurb'),
      icon: <AppIcon brand="website" />,
    },
    ...clientIntegrations
      .filter((i) => i.ImportSection && i.importSource)
      .map((i) => ({ id: i.id, ...i.importSource! })),
    {
      id: 'liveapp',
      title: t('panels.importLiveApp'),
      blurb: t('panels.importLiveAppBlurb'),
      icon: <AppIcon brand="live-app" />,
    },
    {
      id: 'github',
      title: t('panels.importGithub'),
      blurb: t('panels.importGithubBlurb'),
      icon: <AppIcon brand="github" />,
    },
  ]
  return lean ? sources.filter((source) => source.id === 'website' || source.id === 'liveapp') : sources
}
