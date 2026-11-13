import { useState, type ReactNode } from 'react'
import { navigate } from '../App'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { isLean, useLean } from '../lib/lean'
import { ModelAccountPanel } from '../components/ModelAccount'
import { ImageModelCard } from '../components/ImageModelCard'
import { useAllowance } from '../components/TeamAllowance'
import { AccountSettings } from '../components/AccountSettings'
import { AppearanceSettings } from '../components/AppearanceSettings'
import { GeneralSettings } from '../components/GeneralSettings'
import { AgentKeys } from '../components/AgentKeys'
import { Webhooks } from '../components/Webhooks'
import { FontLibrary } from '../components/FontLibrary'
import { AccountMenu } from '../components/DashShell'
import { railLayout } from '../components/AppRail'
import {
  BellIcon,
  ChevronLeftIcon,
  KeyIcon,
  MoonIcon,
  GearIcon,
  SparkIcon,
  TextIcon,
  UserIcon,
} from '../components/ui/icons'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { Progress } from '../components/ui/progress'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSidebar,
  DashSidebarBrand,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'

type Pane = 'general' | 'agent' | 'fonts' | 'keys' | 'webhooks' | 'account' | 'appearance'

/* the heading over each pane, the line under it, and its glyph and label in
   the rail and the phone's tabs, in the order both list them */
const panes: Record<Pane, { title: PlainMessageKey; blurb: PlainMessageKey; tab: PlainMessageKey; icon: ReactNode }> = {
  general: {
    title: 'settings.generalTitle',
    blurb: 'settings.generalBlurb',
    tab: 'settings.generalTitle',
    icon: <GearIcon size="rail" />,
  },
  agent: {
    title: 'settings.agentTitle',
    blurb: 'settings.agentBlurb',
    tab: 'settings.agentTitle',
    icon: <SparkIcon size="rail" />,
  },
  fonts: {
    title: 'settings.fontsTitle',
    blurb: 'settings.fontsBlurb',
    tab: 'settings.fontsTitle',
    icon: <TextIcon size="rail" />,
  },
  keys: {
    title: 'settings.keysTitle',
    blurb: 'settings.keysBlurb',
    tab: 'settings.keysTitle',
    icon: <KeyIcon size="rail" />,
  },
  webhooks: {
    title: 'settings.webhooksTitle',
    blurb: 'settings.webhooksBlurb',
    tab: 'settings.webhooksTitle',
    icon: <BellIcon size="rail" />,
  },
  account: {
    title: 'settings.accountTitle',
    blurb: 'settings.accountBlurb',
    tab: 'settings.accountTab',
    icon: <UserIcon size="rail" />,
  },
  appearance: {
    title: 'settings.appearanceTitle',
    blurb: 'settings.appearanceBlurb',
    tab: 'settings.appearanceTitle',
    icon: <MoonIcon size="rail" />,
  },
}

const PANE_ORDER = Object.keys(panes) as Pane[]

/** the panes this server offers: lean mode has no in-app agent to set up */
function settingsPanes(lean: boolean): Pane[] {
  return lean ? PANE_ORDER.filter((pane) => pane !== 'agent') : PANE_ORDER
}

/** ?pane= deep-links a section — the connect modal sends people to ?pane=keys. */
function initialPane(): Pane {
  const lean = isLean()
  const pane = new URLSearchParams(location.search).get('pane')
  const offered = settingsPanes(lean)
  return offered.find((p) => p === pane) ?? (lean ? 'general' : 'agent')
}

/**
 * Account settings. Today it holds one thing — which model account the Doop
 * Agent runs on once the free tasks are spent — but it is the account-level
 * home for that kind of setting, so the canvas surfaces can link here instead
 * of carrying their own copy of it.
 *
 * It wears the same shell as the home dashboard: same rail, same top bar, same
 * account menu. Only the rail's middle changes, to a settings sub-nav.
 */
export function Settings() {
  /* the sub-nav switches panes rather than scrolling to an anchor — on a page
     this short an anchor jump looks like nothing happened */
  const [pane, setPane] = useState<Pane>(initialPane)
  const t = useT()
  const lean = useLean()
  const offered = settingsPanes(lean)
  const { allowance, refresh } = useAllowance()
  const left = allowance ? Math.max(0, allowance.limit - allowance.used) : null
  /* arriving from a canvas (the free-tier wall) should not cost you your
     place — only same-origin canvas paths are honoured */
  const from = new URLSearchParams(location.search).get('from')
  const back = from && /^\/c\/[A-Za-z0-9_-]+$/.test(from) ? from : '/'

  /* with a connection of their own the table below says what runs; the
     line only counts free tasks, or names the operator's pilot */
  const meter = allowance
    ? allowance.byoModel
      ? allowance.byoKind === 'gemini-cloud'
        ? t('settings.meterGeminiCloud')
        : null
      : allowance.limit <= 0
        ? t('settings.meterNoFreeTasks')
        : left === 0
          ? t('settings.meterUsedUp')
          : t('settings.meterLeft', { left: left ?? 0, count: allowance.limit })
    : null

  return (
    <DashLayout className={railLayout}>
      {/* Settings is its own screen: a rail of its panes, and the way back */}
      <DashSidebar variant="rail">
        <DashSidebarBrand />
        <nav className="flex flex-col gap-0.5">
          <DashNavItem density="rail" icon={<ChevronLeftIcon size="rail" />} onClick={() => navigate(back)}>
            {back === '/' ? t('settings.backToCanvases') : t('settings.backToCanvas')}
          </DashNavItem>
        </nav>
        <DashSectionLabel density="rail">{t('settings.sectionLabel')}</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          {offered.map((p) => (
            <DashNavItem key={p} density="rail" icon={panes[p].icon} active={pane === p} onClick={() => setPane(p)}>
              {t(panes[p].title)}
            </DashNavItem>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2.5 px-1 pt-4">
          <AccountMenu face side="top" align="start" />
        </div>
      </DashSidebar>

      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare" className="md:hidden">
          <Button variant="ghost" size="bar" onClick={() => navigate(back)}>
            <ChevronLeftIcon size="rail" /> {back === '/' ? t('settings.canvases') : t('settings.canvas')}
          </Button>
          <span className="flex-1" />
          <AccountMenu />
        </DashHeader>

        <DashContent className="pt-2 md:pt-7">
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>{t(panes[pane].title)}</DashTitle>
              <DashSubtitle>{t(panes[pane].blurb)}</DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList
              variant="card"
              className="grid h-auto grid-cols-2 group-data-horizontal/tabs:h-auto sm:grid-cols-3 [&>*]:h-8"
            >
              {offered.map((p) => (
                <TabsTrigger key={p} value={p}>
                  {panes[p].icon} {t(panes[p].tab)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {pane === 'general' ? (
            <GeneralSettings />
          ) : pane === 'agent' ? (
            <>
              {/* the free-task count, while no connection of the person's own carries the agent */}
              {meter && (
                <div className="mt-4 flex max-w-[1000px] flex-col items-start gap-[7px] text-caption text-ink-faint sm:flex-row sm:items-center sm:gap-2.5">
                  {allowance && allowance.limit > 0 && !allowance.byoModel && (
                    <Progress
                      className="w-[min(100%,240px)] sm:w-[180px]"
                      value={left ?? 0}
                      max={allowance.limit}
                      aria-label={t('settings.freeTasksLeftLabel')}
                    />
                  )}
                  <span>{meter}</span>
                </div>
              )}
              <ModelAccountPanel onChange={refresh} />
              <ImageModelCard />
            </>
          ) : pane === 'fonts' ? (
            <FontLibrary />
          ) : pane === 'keys' ? (
            <AgentKeys />
          ) : pane === 'webhooks' ? (
            <Webhooks />
          ) : pane === 'account' ? (
            <AccountSettings />
          ) : (
            <AppearanceSettings />
          )}
        </DashContent>
      </DashMain>
    </DashLayout>
  )
}
