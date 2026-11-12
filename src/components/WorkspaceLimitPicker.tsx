import { useEffect, useState } from 'react'
import { api, type WorkspaceLimit } from '../lib/api'
import { useT } from '../lib/i18n'
import type { WorkspaceSummary } from '../../shared/types'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Note } from './ui/note'
import { Segmented, SegmentedItem } from './ui/segmented'

/** The signed-in person's workspaces. `list` is null until they load; a
 *  failed load stays `failed` rather than an empty list, since an empty list
 *  means "no workspaces" and would offer only every canvas. */
export interface MyWorkspaces {
  list: WorkspaceSummary[] | null
  failed: boolean
  retry: () => void
}

export function useMyWorkspaces(): MyWorkspaces {
  const [attempt, setAttempt] = useState(0)
  const [list, setList] = useState<WorkspaceSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    api.listWorkspaces().then(
      (res) => active && setList(res.workspaces),
      (e: unknown) => {
        console.error(e)
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [attempt])
  return {
    list,
    failed,
    retry: () => {
      setFailed(false)
      setAttempt((n) => n + 1)
    },
  }
}

export interface WorkspaceLimitLabels {
  all: string
  some: string
  aria: string
  groupAria: string
  pickOne: string
  loadFailed: string
}

export interface WorkspaceLimitWords {
  all: string
  /** a limit whose workspaces are all out of reach: it reaches no canvas */
  none: string
  some: (names: string) => string
}

/** One limit's words: every canvas, the workspaces by name, or none left. */
export function workspaceLimitText(limit: WorkspaceLimit, words: WorkspaceLimitWords): string {
  if (!limit) return words.all
  if (!limit.length) return words.none
  return words.some(limit.map((w) => w.name).join(', '))
}

/** Every canvas (null), or only the checked workspaces. With no workspaces
 *  there is nothing to choose, so it names the one option it has. Callers keep
 *  their save disabled while `workspaces.list` is null: until the list loads
 *  the choice was never offered. */
export function WorkspaceLimitPicker({
  workspaces,
  value,
  onChange,
  labels,
}: {
  workspaces: MyWorkspaces
  value: string[] | null
  onChange: (next: string[] | null) => void
  labels: WorkspaceLimitLabels
}) {
  const t = useT()
  if (workspaces.failed) {
    return (
      <>
        <Note tone="error" role="alert">
          {labels.loadFailed}
        </Note>
        <Button size="sm" variant="ghost" onClick={workspaces.retry}>
          {t('common.retry')}
        </Button>
      </>
    )
  }
  if (!workspaces.list) return <Note role="status">{t('common.loading')}</Note>
  if (!workspaces.list.length) return <span className="text-body text-ink">{labels.all}</span>
  return (
    <>
      <Segmented
        value={value ? 'some' : 'all'}
        onValueChange={(next) => onChange(next === 'some' ? [] : null)}
        aria-label={labels.aria}
      >
        <SegmentedItem value="all">{labels.all}</SegmentedItem>
        <SegmentedItem value="some">{labels.some}</SegmentedItem>
      </Segmented>
      {value && (
        <div role="group" aria-label={labels.groupAria} className="grid min-w-0 basis-full gap-1.5 sm:grid-cols-2">
          {workspaces.list.map((workspace) => {
            const on = value.includes(workspace.id)
            return (
              <label key={workspace.id} className="relative flex cursor-pointer items-center gap-2 text-body text-ink">
                <Checkbox
                  checked={on}
                  onChange={() => onChange(on ? value.filter((id) => id !== workspace.id) : [...value, workspace.id])}
                />
                <span className="min-w-0 truncate">{workspace.name}</span>
              </label>
            )
          })}
          {value.length === 0 && <Note className="sm:col-span-2">{labels.pickOne}</Note>}
        </div>
      )}
    </>
  )
}
