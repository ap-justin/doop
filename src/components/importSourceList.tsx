import { clientIntegrations } from '@/integrations'
import { AppIcon } from './ui/brand-mark'
import type { ImportSource } from './ImportSources'
import { t as translate, type Translate } from '@/lib/i18n'
import { isLean } from '@/lib/lean'

/** The sources the import picker offers, in order — the canvas page's modal
 *  and Home's Import button show the same list, so it lives once. Lean mode
 *  turns integrations and GitHub import off, which leaves the website and the
 *  live app. */
export function importSources(t: Translate = translate, lean: boolean = isLean()): ImportSource[] {
  const website: ImportSource = {
    id: 'website',
    title: t('panels.importWebsite'),
    blurb: t('panels.importWebsiteBlurb'),
    icon: <AppIcon brand="website" />,
  }
  const liveApp: ImportSource = {
    id: 'liveapp',
    title: t('panels.importLiveApp'),
    blurb: t('panels.importLiveAppBlurb'),
    icon: <AppIcon brand="live-app" />,
  }
  if (lean) return [website, liveApp]
  return [
    website,
    ...clientIntegrations
      .filter((i) => i.ImportSection && i.importSource)
      .map((i) => ({ id: i.id, ...i.importSource! })),
    liveApp,
    {
      id: 'github',
      title: t('panels.importGithub'),
      blurb: t('panels.importGithubBlurb'),
      icon: <AppIcon brand="github" />,
    },
  ]
}
