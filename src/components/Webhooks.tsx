import { useEffect, useRef, useState } from 'react'
import { api, errorMessage, type WebhookListing } from '../lib/api'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { WEBHOOK_EVENTS, type WebhookEventType } from '../../shared/webhooks'
import { t as translate, useT, type PlainMessageKey, type Translate } from '../lib/i18n'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { Checkbox } from './ui/checkbox'
import { CodeBlock } from './ui/code-block'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { TrashIcon } from './ui/icons'
import { useMyWorkspaces, workspaceLimitText, WorkspaceLimitPicker } from './WorkspaceLimitPicker'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** What each event means, in the reader's language. The event names stay as
 *  they are — receivers match on them — and the shared English labels stay
 *  with the server. */
const EVENT_LABELS: Record<WebhookEventType, PlainMessageKey> = {
  'comment.created': 'webhooks.eventCommentCreated',
  'comment.replied': 'webhooks.eventCommentReplied',
  'comment.resolved': 'webhooks.eventCommentResolved',
  'frame.created': 'webhooks.eventFrameCreated',
  'task.completed': 'webhooks.eventTaskCompleted',
  'task.failed': 'webhooks.eventTaskFailed',
}

/** The one-line health of a hook, phrased for a person. */
function health(hook: WebhookListing, t: Translate): { text: string; tone?: 'error' | 'success' } {
  /* a paused hook's reason is the server's own text */
  if (!hook.enabled && hook.lastError?.startsWith('paused')) return { text: hook.lastError, tone: 'error' }
  if (!hook.enabled) return { text: t('webhooks.healthOff') }
  if (!hook.lastAt) return { text: t('webhooks.healthNoDeliveries') }
  if (hook.failures) {
    return {
      text: t('webhooks.healthFailing', {
        count: hook.failures,
        when: timeAgo(hook.lastAt),
        error: hook.lastError ?? t('webhooks.healthFailed'),
      }),
      tone: 'error',
    }
  }
  return {
    text: t('webhooks.healthDelivered', { when: timeAgo(hook.lastAt), status: String(hook.lastStatus) }),
    tone: 'success',
  }
}

/** A row's own line in place of its health. `from: 'limit'` marks a failed
 *  limit save, the only note the limit editor clears. */
interface RowNote {
  text: string
  tone?: 'error' | 'success'
  from?: 'limit'
}

/** Picks events with their labels; used for the new-hook form. */
function EventPicker({ value, onChange }: { value: WebhookEventType[]; onChange: (next: WebhookEventType[]) => void }) {
  const t = useT()
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {WEBHOOK_EVENTS.map((event) => {
        const on = value.includes(event)
        return (
          <label key={event} className="relative flex cursor-pointer items-center gap-2 text-body text-ink">
            <Checkbox
              checked={on}
              onChange={() => onChange(on ? value.filter((e) => e !== event) : [...value, event])}
              aria-label={t(EVENT_LABELS[event])}
            />
            <span>
              <code className="font-mono text-caption text-ink-soft">{event}</code>
              <span className="text-ink-faint"> · {t(EVENT_LABELS[event])}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

/** The "Webhooks" pane of /settings: register URLs doop POSTs canvas events
 *  to, see whether they answer, rotate their secrets. The secret appears once,
 *  on creation or rotation — the list never carries it. */
export function Webhooks() {
  const t = useT()
  const [hooks, setHooks] = useState<WebhookListing[] | null>(null)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEventType[]>([...WEBHOOK_EVENTS])
  const workspaces = useMyWorkspaces()
  /* null delivers from every canvas; a list only from those workspaces */
  const [limit, setLimit] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /* the one moment a secret exists client-side */
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /* the action awaiting "are you sure" — an in-app dialog, since
     window.confirm is a silent "cancel" in the desktop shell's webview */
  const [confirming, setConfirming] = useState<{ kind: 'rotate' | 'remove'; hook: WebhookListing } | null>(null)
  /* the hook whose limit is being changed, and the pick so far */
  const [editing, setEditing] = useState<{ id: string; value: string[] | null } | null>(null)
  const [rowNote, setRowNote] = useState<Record<string, RowNote>>({})
  const editorRef = useRef<HTMLDivElement>(null)
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  /* the hook whose "Change canvases" button gets focus back once it is enabled again */
  const returnFocusTo = useRef<string | null>(null)
  const editingId = editing?.id

  /* the opened editor takes focus from its button, which it disables: the
     chosen segment, which Radix then makes the picker's tab stop (this runs
     before Radix's own re-render sets any tabindex to 0), or, with no choice
     to offer, the first enabled button: Retry, Cancel while loading, Save */
  useEffect(() => {
    if (!editingId) return
    editorRef.current
      ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], button:not([disabled])')
      ?.focus()
  }, [editingId])

  useEffect(() => {
    const id = returnFocusTo.current
    if (!id) return
    /* another hook's editor is open and holds focus */
    if (editing) {
      returnFocusTo.current = null
      return
    }
    /* still saving: the button is disabled until the save settles */
    if (busy === id) return
    returnFocusTo.current = null
    const active = document.activeElement
    /* only when closing the editor dropped focus, never over a control the person moved to */
    if (!active || active === document.body || !active.isConnected) editButtons.current.get(id)?.focus()
  }, [editing, busy])

  useEffect(() => {
    api.listWebhooks().then(setHooks, (e: unknown) => {
      console.error(e)
      setHooks([])
      /* the free translator: the effect runs once, and useT's `t` is new every render */
      setError(errorMessage(e, translate('webhooks.loadFailed')))
    })
  }, [])

  /* a ping result or another action's failure stays until something replaces it */
  function clearLimitNote(id: string) {
    setRowNote((notes) => {
      if (notes[id]?.from !== 'limit') return notes
      const { [id]: _cleared, ...rest } = notes
      return rest
    })
  }

  function openEditor(hook: WebhookListing) {
    returnFocusTo.current = null
    clearLimitNote(hook.id)
    setEditing({ id: hook.id, value: hook.workspaces?.map((w) => w.id) ?? null })
  }

  function closeEditor(id: string) {
    returnFocusTo.current = id
    clearLimitNote(id)
    setEditing(null)
  }

  function replace(next: WebhookListing) {
    setHooks((current) => current?.map((h) => (h.id === next.id ? next : h)) ?? null)
  }

  async function create() {
    setSaving(true)
    setError('')
    try {
      const { secret: fresh, ...info } = await api.createWebhook({
        url: url.trim(),
        events,
        workspaceIds: limit ?? undefined,
      })
      posthog.capture('webhook_created', { events })
      setUrl('')
      setLimit(null)
      setSecret({ id: info.id, secret: fresh })
      setHooks((current) => [info, ...(current ?? [])])
    } catch (e) {
      setError(errorMessage(e, t('webhooks.createFailed')))
    } finally {
      setSaving(false)
    }
  }

  async function act(hook: WebhookListing, work: () => Promise<void>, failure: string, from?: RowNote['from']) {
    setBusy(hook.id)
    try {
      await work()
    } catch (e) {
      setRowNote((n) => ({ ...n, [hook.id]: { text: errorMessage(e, failure), tone: 'error', from } }))
    } finally {
      setBusy(null)
    }
  }

  const test = (hook: WebhookListing) =>
    act(
      hook,
      async () => {
        const result = await api.testWebhook(hook.id)
        setRowNote((n) => ({
          ...n,
          [hook.id]: result.ok
            ? { text: t('webhooks.pingAnswered', { status: String(result.status) }), tone: 'success' }
            : {
                text: t('webhooks.pingFailed', { error: result.error ?? t('webhooks.pingNoResponse') }),
                tone: 'error',
              },
        }))
        const fresh = await api.listWebhooks()
        setHooks(fresh)
      },
      t('webhooks.testFailed'),
    )

  const toggle = (hook: WebhookListing) =>
    act(
      hook,
      async () => replace(await api.updateWebhook(hook.id, { enabled: !hook.enabled })),
      t('webhooks.toggleFailed'),
    )

  /* `value` is null (every canvas) or a non-empty list: Save is disabled at [] */
  const saveLimit = (hook: WebhookListing, value: string[] | null) =>
    act(
      hook,
      async () => {
        replace(await api.updateWebhook(hook.id, { workspaceIds: value }))
        clearLimitNote(hook.id)
        returnFocusTo.current = hook.id
        /* the person may have moved on to another hook's editor while this one saved */
        setEditing((current) => (current?.id === hook.id ? null : current))
      },
      t('webhooks.limitSaveFailed'),
      'limit',
    )

  const rotate = (hook: WebhookListing) =>
    act(
      hook,
      async () => {
        const { secret: fresh } = await api.rotateWebhookSecret(hook.id)
        posthog.capture('webhook_secret_rotated')
        setSecret({ id: hook.id, secret: fresh })
      },
      t('webhooks.rotateFailed'),
    )

  const remove = (hook: WebhookListing) =>
    act(
      hook,
      async () => {
        await api.deleteWebhook(hook.id)
        posthog.capture('webhook_deleted')
        setHooks((current) => current?.filter((h) => h.id !== hook.id) ?? null)
        if (secret?.id === hook.id) setSecret(null)
      },
      t('webhooks.removeFailed'),
    )

  const limitLabels = {
    all: t('webhooks.limitAll'),
    some: t('webhooks.limitSome'),
    aria: t('webhooks.limitAria'),
    groupAria: t('webhooks.limitGroupAria'),
    pickOne: t('webhooks.limitPickOne'),
    loadFailed: t('webhooks.limitLoadFailed'),
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('webhooks.title')}</CardTitle>
        <CardDescription>
          {t('webhooks.descriptionBefore')}
          <code className="font-mono text-label">X-Doop-Signature</code>
          {t('webhooks.descriptionAfter')}
        </CardDescription>
      </CardHeader>

      <CardRow
        label={t('webhooks.newWebhookRow')}
        action={
          <Button
            size="sm"
            disabled={
              saving ||
              hooks === null ||
              workspaces.list === null ||
              !url.trim() ||
              !events.length ||
              limit?.length === 0
            }
            onClick={create}
          >
            {saving ? t('webhooks.adding') : t('webhooks.addWebhook')}
          </Button>
        }
        controlWidth="lg"
        control={
          <Input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError('')
            }}
            placeholder="https://hooks.example.com/doop"
            inputMode="url"
            aria-label={t('webhooks.urlAria')}
          />
        }
      >
        {/* basis-full drops the picker onto its own line under the URL field */}
        <div className="min-w-0 basis-full">
          <EventPicker value={events} onChange={setEvents} />
          {error && <Note tone="error">{error}</Note>}
        </div>
      </CardRow>

      <CardRow label={t('webhooks.canvasesRow')}>
        <WorkspaceLimitPicker workspaces={workspaces} value={limit} onChange={setLimit} labels={limitLabels} />
      </CardRow>

      {secret && (
        <CardRow label={t('webhooks.signingSecretRow')}>
          <div className="min-w-0 flex-1">
            <Note tone="success">{t('webhooks.copyNow')}</Note>
            <CodeBlock className="mt-2" text={secret.secret} />
            <Note>{t('webhooks.signatureFormula')}</Note>
          </div>
        </CardRow>
      )}

      {hooks?.map((hook) => {
        const note = rowNote[hook.id]
        const status = note ?? health(hook, t)
        const host = hostOf(hook.url)
        /* with no workspace to pick, every canvas is the only answer: a limit
           whose workspaces are all gone can then still be lifted */
        const editValue = workspaces.list?.length === 0 ? null : (editing?.value ?? null)
        return (
          <CardRow
            key={hook.id}
            label={host}
            action={
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="ghost" disabled={busy === hook.id} onClick={() => void test(hook)}>
                  {t('webhooks.sendTest')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === hook.id}
                  onClick={() => setConfirming({ kind: 'rotate', hook })}
                >
                  {t('webhooks.rotateSecret')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  ref={(el) => {
                    if (el) editButtons.current.set(hook.id, el)
                    else editButtons.current.delete(hook.id)
                  }}
                  disabled={busy === hook.id || editing?.id === hook.id}
                  aria-label={t('webhooks.editLimitAria', { host })}
                  onClick={() => openEditor(hook)}
                >
                  {t('webhooks.editLimit')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === hook.id} onClick={() => void toggle(hook)}>
                  {hook.enabled ? t('webhooks.turnOff') : t('webhooks.turnOn')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === hook.id}
                  aria-label={t('webhooks.removeAria', { host })}
                  onClick={() => setConfirming({ kind: 'remove', hook })}
                >
                  <TrashIcon /> {t('webhooks.remove')}
                </Button>
              </div>
            }
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-body text-ink-soft" title={hook.url}>
                {hook.url}
              </div>
              <div className="mt-1 text-caption text-ink-faint">{hook.events.join(' · ')}</div>
              <div className="mt-1 text-caption text-ink-faint">
                {workspaceLimitText(hook.workspaces, {
                  all: t('webhooks.limitAll'),
                  none: t('webhooks.limitNone'),
                  some: (names) => t('webhooks.limitedTo', { names }),
                })}
              </div>
              {editing?.id === hook.id && (
                <div ref={editorRef} className="mt-2 flex flex-wrap items-center gap-2.5">
                  <WorkspaceLimitPicker
                    workspaces={workspaces}
                    value={editValue}
                    onChange={(value) => setEditing({ id: hook.id, value })}
                    labels={{
                      ...limitLabels,
                      aria: t('webhooks.limitAriaFor', { host }),
                      groupAria: t('webhooks.limitGroupAriaFor', { host }),
                    }}
                  />
                  <div className="flex basis-full flex-wrap gap-1">
                    <Button
                      size="sm"
                      disabled={busy === hook.id || workspaces.list === null || editValue?.length === 0}
                      onClick={() => void saveLimit(hook, editValue)}
                    >
                      {t('common.save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => closeEditor(hook.id)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              )}
              {/* a failed action is announced; a failing hook's health line is not */}
              <Note tone={status.tone} role={note?.tone === 'error' ? 'alert' : undefined}>
                {status.text}
              </Note>
            </div>
          </CardRow>
        )
      })}
      {hooks && hooks.length === 0 && !secret && (
        <CardRow label={t('webhooks.noWebhooksRow')}>
          <Note>{t('webhooks.noWebhooksNote')}</Note>
        </CardRow>
      )}
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={
          confirming?.kind === 'rotate'
            ? t('webhooks.rotateConfirmTitle', { host: confirming ? hostOf(confirming.hook.url) : '' })
            : t('webhooks.removeConfirmTitle', { host: confirming ? hostOf(confirming.hook.url) : '' })
        }
        description={confirming?.kind === 'rotate' ? t('webhooks.rotateConfirmDescription') : undefined}
        confirmLabel={confirming?.kind === 'rotate' ? t('webhooks.rotateSecret') : t('webhooks.removeWebhook')}
        destructive
        onConfirm={() => {
          const target = confirming
          setConfirming(null)
          if (target) void (target.kind === 'rotate' ? rotate(target.hook) : remove(target.hook))
        }}
      />
    </SettingsCard>
  )
}
