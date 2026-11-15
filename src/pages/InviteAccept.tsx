import { useEffect, useState } from 'react'
import { navigate } from '../App'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { api, ApiError } from '../lib/api'
import { authClient } from '../lib/auth'
import { useT } from '../lib/i18n'
import type { InviteLinkInfo } from '../../shared/inviteLinks'

/** The page behind `/invite/<token>`: who invited you and to what, the fixed
 *  email, and a name and password that create the account. Every link that is
 *  expired, used, revoked or unknown shows the one same message. */
export function InviteAccept({ token, signedInAs }: { token: string; signedInAs?: string }) {
  const t = useT()
  const [info, setInfo] = useState<InviteLinkInfo | 'invalid' | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api
      .inviteLink(token)
      .then((found) => active && setInfo(found))
      .catch(() => active && setInfo('invalid'))
    return () => {
      active = false
    }
  }, [token])

  /* an account that already exists joins as soon as it is signed in as the invited address */
  const matches =
    typeof info === 'object' && info !== null && signedInAs?.toLowerCase() === info.email && info.accountExists
  useEffect(() => {
    if (!matches) return
    api
      .joinInviteLink(token)
      .then((done) => location.assign(done.landing))
      .catch(() => setInfo('invalid'))
  }, [matches, token])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const done = await api.acceptInviteLink(token, { name: name.trim(), password })
      location.assign(done.landing)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) setInfo('invalid')
      else if (caught instanceof ApiError && caught.status === 409)
        setInfo((current) => (typeof current === 'object' && current ? { ...current, accountExists: true } : current))
      else setError(caught instanceof ApiError ? String(caught.body.error ?? t('invite.failed')) : t('invite.failed'))
      setBusy(false)
    }
  }

  if (info === null)
    return (
      <AuthScreen>
        <AuthCard title={t('common.loading')}>{null}</AuthCard>
      </AuthScreen>
    )

  if (info === 'invalid')
    return (
      <AuthScreen>
        <AuthCard title={t('invite.invalidTitle')}>
          <AuthCardText>{t('invite.invalidText')}</AuthCardText>
        </AuthCard>
      </AuthScreen>
    )

  const title = t(info.kind === 'workspace' ? 'invite.titleWorkspace' : 'invite.titleCanvas', { name: info.targetName })
  const lede = t(info.kind === 'workspace' ? 'invite.ledeWorkspace' : 'invite.ledeCanvas', {
    inviter: info.inviterName,
    name: info.targetName,
  })

  if (info.accountExists) {
    const other = signedInAs && !matches
    return (
      <AuthScreen>
        <AuthCard title={other ? title : matches ? t('invite.joining') : t('invite.existsTitle')}>
          <AuthCardText>{lede}</AuthCardText>
          {other ? (
            <>
              <Callout>{t('invite.wrongAccount', { current: signedInAs, email: info.email })}</Callout>
              <Button
                variant="solid"
                onClick={() => void authClient.signOut().then(() => location.assign(`/invite/${token}`))}
              >
                {t('invite.signOut')}
              </Button>
            </>
          ) : !matches ? (
            <>
              <AuthCardText>{t('invite.existsText', { email: info.email })}</AuthCardText>
              <Button
                variant="solid"
                onClick={() => navigate(`/?redirect_to=${encodeURIComponent(`/invite/${token}`)}`)}
              >
                {t('invite.signIn')}
              </Button>
            </>
          ) : null}
        </AuthCard>
      </AuthScreen>
    )
  }

  return (
    <AuthScreen>
      <AuthCard as="form" title={title} onSubmit={(event) => void create(event)}>
        <AuthCardText>{lede}</AuthCardText>
        <Field label={t('invite.email')} labelVariant="form" htmlFor="invite-email">
          <Input id="invite-email" variant="well" type="email" value={info.email} readOnly autoComplete="email" />
        </Field>
        <Field label={t('invite.name')} labelVariant="form" htmlFor="invite-name">
          <Input
            id="invite-name"
            variant="well"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
          />
        </Field>
        <Field
          label={t('invite.password')}
          labelVariant="form"
          htmlFor="invite-password"
          hint={t('invite.passwordHint')}
        >
          <Input
            id="invite-password"
            variant="well"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        {error && <Callout tone="error">{error}</Callout>}
        <Button type="submit" variant="solid" disabled={busy || !name.trim() || password.length < 8}>
          {busy ? t('invite.creating') : t('invite.create')}
        </Button>
      </AuthCard>
    </AuthScreen>
  )
}
