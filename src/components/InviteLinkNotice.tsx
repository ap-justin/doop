import { useState } from 'react'
import { Button } from './ui/button'
import { CopyIcon } from './ui/icons'
import { Input } from './ui/input'
import { useT } from '@/lib/i18n'

/** The link an inviter sends to an address with no account yet: what to do
 *  with it, and a Copy button. Shown right after inviting, since only its
 *  hash is kept on the server. Mount it with `key={link}`, so a new link
 *  never inherits the last one's "Link copied". */
export function InviteLinkNotice({ email, link }: { email: string; link: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

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
