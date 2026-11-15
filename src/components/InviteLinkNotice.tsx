import { useState } from 'react'
import { Button } from './ui/button'
import { CopyIcon } from './ui/icons'
import { Input } from './ui/input'
import { useT } from '@/lib/i18n'

/** What the inviter sees right after inviting an address with no account yet.
 *  Without a mailer, the link to send and a Copy button (only its hash is kept
 *  on the server). With one there is no `link`: it went to the address by
 *  email alone, and the inviter never holds it. Mount it with `key={link ?? email}`,
 *  so a new invite never inherits the last one's "Link copied". It is no live
 *  region itself: a region inserted with its text already inside is not reliably
 *  read, so the caller announces it, either by rendering it inside an always-mounted
 *  `role="status"` (ShareModal) or through its own toast (the Workspace members pane). */
export function InviteLinkNotice({ email, link }: { email: string; link?: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  if (!link)
    return (
      <p className="mt-3 text-label text-ink-soft" data-testid="invite-sent-notice">
        {t('invite.sent', { email })}
      </p>
    )

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="invite-link-notice">
      <p className="text-label text-ink-soft">{t('invite.linkLine', { email })}</p>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row">
        {/* ph-no-capture: session replay records the box, never the token in it */}
        <Input
          variant="well"
          className="ph-no-capture flex-1 font-mono"
          readOnly
          value={link}
          aria-label={t('invite.linkAria', { email })}
          onFocus={(event) => event.target.select()}
        />
        <Button className="justify-center gap-2" onClick={() => void copy()}>
          <CopyIcon className="size-3.5" />
          {copied ? t('invite.linkCopied') : t('invite.copyLink')}
        </Button>
      </div>
      {failed && <p className="text-label text-accent-ink">{t('invite.copyFailed')}</p>}
    </div>
  )
}
