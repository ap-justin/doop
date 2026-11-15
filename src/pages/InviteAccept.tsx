import { useCallback, useEffect, useRef, useState } from 'react'
import { navigate } from '../App'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { api, ApiError } from '../lib/api'
import { authClient } from '../lib/auth'
import { useT, type PlainMessageKey } from '../lib/i18n'
import type { InviteLinkInfo } from '../../shared/inviteLinks'

/** What a failed accept or join means for the page. Only the server's own
 *  `invalid` ends the link; a rate limit, an overlapping request (409), a
 *  server error or a dropped connection leave it usable, so the person retries. */
type Failure = { kind: 'invalid' } | { kind: 'account-exists' } | { kind: 'retry'; message: PlainMessageKey }

function failureOf(caught: unknown, fallback: PlainMessageKey): Failure {
  if (!(caught instanceof ApiError)) return { kind: 'retry', message: 'auth.networkError' }
  const code = caught.body.error
  if (caught.status === 404 && code === 'invalid') return { kind: 'invalid' }
  if (caught.status === 409 && code === 'account-exists') return { kind: 'account-exists' }
  if (caught.status === 409) return { kind: 'retry', message: 'invite.stillWorking' }
  if (caught.status === 429) return { kind: 'retry', message: 'invite.tooManyAttempts' }
  /* better-auth's sign-up rules answer in English ("Password too long") */
  if (caught.status === 400 && typeof code === 'string' && /password/i.test(code))
    return { kind: 'retry', message: 'invite.passwordRejected' }
  return { kind: 'retry', message: fallback }
}

/** The page behind `/invite/<token>`: who invited you and to what, the fixed
 *  email, and a name and password that create the account. Every link that is
 *  expired, used, revoked or unknown shows the one same message. */
export function InviteAccept({ token, signedInAs }: { token: string; signedInAs?: string }) {
  const t = useT()
  const [info, setInfo] = useState<InviteLinkInfo | 'invalid' | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PlainMessageKey | null>(null)
  const [joinError, setJoinError] = useState<PlainMessageKey | null>(null)
  /* a spent token answers `invalid`, so a second request racing the first
     (StrictMode's repeated effect, a double click) would flash the dead-link card */
  const submitting = useRef(false)
  const joining = useRef(false)

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

  const found = typeof info === 'object' && info !== null ? info : null
  const signedInElsewhere = found !== null && signedInAs !== undefined && signedInAs.toLowerCase() !== found.email
  /* an account that already exists joins as soon as it is signed in as the invited address */
  const joinsNow = found !== null && signedInAs !== undefined && !signedInElsewhere && found.accountExists

  const requestJoin = useCallback(() => {
    if (joining.current) return
    joining.current = true
    api
      .joinInviteLink(token)
      .then((done) => location.assign(done.landing))
      .catch((caught: unknown) => {
        joining.current = false
        const failure = failureOf(caught, 'invite.joinFailed')
        if (failure.kind === 'invalid') setInfo('invalid')
        else setJoinError(failure.kind === 'retry' ? failure.message : 'invite.joinFailed')
      })
  }, [token])

  useEffect(() => {
    if (joinsNow) requestJoin()
  }, [joinsNow, requestJoin])

  function retryJoin() {
    setJoinError(null)
    requestJoin()
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const done = await api.acceptInviteLink(token, { name: name.trim(), password })
      location.assign(done.landing)
    } catch (caught) {
      submitting.current = false
      setBusy(false)
      const failure = failureOf(caught, 'invite.failed')
      if (failure.kind === 'invalid') setInfo('invalid')
      else if (failure.kind === 'account-exists')
        setInfo((current) => (typeof current === 'object' && current ? { ...current, accountExists: true } : current))
      else setError(failure.message)
    }
  }

  if (found === null)
    return (
      <AuthScreen>
        {info === 'invalid' ? (
          <AuthCard title={t('invite.invalidTitle')}>
            <AuthCardText>{t('invite.invalidText')}</AuthCardText>
          </AuthCard>
        ) : (
          <AuthCard title={t('common.loading')}>{null}</AuthCard>
        )}
      </AuthScreen>
    )

  const title = t(found.kind === 'workspace' ? 'invite.titleWorkspace' : 'invite.titleCanvas', {
    name: found.targetName,
  })
  const lede = t(found.kind === 'workspace' ? 'invite.ledeWorkspace' : 'invite.ledeCanvas', {
    inviter: found.inviterName,
    name: found.targetName,
  })

  /* creating the account here would sign this browser into it, out of the
     account it is in now, so the other account signs out first */
  if (signedInAs !== undefined && signedInElsewhere)
    return (
      <AuthScreen>
        <AuthCard title={title}>
          <AuthCardText>{lede}</AuthCardText>
          <Callout>{t('invite.wrongAccount', { current: signedInAs, email: found.email })}</Callout>
          <AuthCardText>{t('invite.wrongAccountHint', { email: found.email })}</AuthCardText>
          <Button
            variant="solid"
            onClick={() => void authClient.signOut().then(() => location.assign(`/invite/${token}`))}
          >
            {t('invite.signOut')}
          </Button>
        </AuthCard>
      </AuthScreen>
    )

  if (joinsNow)
    return (
      <AuthScreen>
        <AuthCard title={t('invite.joining')}>
          <AuthCardText>{lede}</AuthCardText>
          {joinError && (
            <>
              <Callout tone="error">{t(joinError)}</Callout>
              <Button variant="solid" onClick={retryJoin}>
                {t('common.retry')}
              </Button>
            </>
          )}
        </AuthCard>
      </AuthScreen>
    )

  if (found.accountExists)
    return (
      <AuthScreen>
        <AuthCard title={t('invite.existsTitle')}>
          <AuthCardText>{lede}</AuthCardText>
          <AuthCardText>{t('invite.existsText', { email: found.email })}</AuthCardText>
          <Button variant="solid" onClick={() => navigate(`/?redirect_to=${encodeURIComponent(`/invite/${token}`)}`)}>
            {t('invite.signIn')}
          </Button>
        </AuthCard>
      </AuthScreen>
    )

  return (
    <AuthScreen>
      <AuthCard as="form" title={title} onSubmit={(event) => void create(event)}>
        <AuthCardText>{lede}</AuthCardText>
        <Field label={t('invite.email')} labelVariant="form" htmlFor="invite-email">
          <Input id="invite-email" variant="well" type="email" value={found.email} readOnly autoComplete="username" />
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
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        {error && <Callout tone="error">{t(error)}</Callout>}
        <Button type="submit" variant="solid" disabled={busy || !name.trim() || password.length < 8}>
          {busy ? t('invite.creating') : t('invite.create')}
        </Button>
      </AuthCard>
    </AuthScreen>
  )
}
