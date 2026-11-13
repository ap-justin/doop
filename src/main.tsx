import React from 'react'
import ReactDOM from 'react-dom/client'
import { loadAnalytics } from './lib/posthog'
import { App } from './App'
import { initDesktopShell } from './lib/desktop'
import { TooltipProvider } from './components/ui/tooltip'
import { UpdateCard } from './components/UpdateCard'
import { initTheme } from './lib/theme'
import { initLocale } from './lib/i18n'
import { installTranslateGuard } from './lib/translateGuard'
import './styles.css'

installTranslateGuard()
initDesktopShell()
initTheme()

/* the language and lean mode are settled first, so the first paint already
   speaks it and shows only what the server offers */
void initLocale().then(() => {
  void loadAnalytics()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <TooltipProvider>
        <App />
        <UpdateCard />
      </TooltipProvider>
    </React.StrictMode>,
  )
})
