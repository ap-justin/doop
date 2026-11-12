import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const mocks = vi.hoisted(() => {
  class WebhookInputError extends Error {}
  return {
    WebhookInputError,
    list: vi.fn(() => [{ id: 'w1', url: 'https://hooks.example.com/' }]),
    create: vi.fn(async () => ({ info: { id: 'w1', url: 'https://hooks.example.com/' }, secret: 'whsec_x' })),
    update: vi.fn(async () => ({ id: 'w1', enabled: false })),
    remove: vi.fn(async () => true),
    rotate: vi.fn(async () => 'whsec_y'),
    test: vi.fn(async () => ({ ok: true, status: 200 })),
  }
})
vi.mock('../server/webhooks.ts', () => ({
  WebhookInputError: mocks.WebhookInputError,
  listWebhooks: mocks.list,
  createWebhook: mocks.create,
  updateWebhook: mocks.update,
  deleteWebhook: mocks.remove,
  rotateWebhookSecret: mocks.rotate,
  testWebhook: mocks.test,
}))
import { webhooksRouter } from '../server/webhookRoutes.ts'

let server: Server
let origin: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'alice' } as typeof req.user
    next()
  })
  app.use(webhooksRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => vi.clearAllMocks())

const json = (method: string, path: string, body?: unknown) =>
  fetch(origin + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

it('lists the signed-in user’s hooks', async () => {
  const res = await json('GET', '/')
  expect(await res.json()).toEqual([{ id: 'w1', url: 'https://hooks.example.com/' }])
  expect(mocks.list).toHaveBeenCalledWith('alice')
})

it('creates a hook and returns the secret once', async () => {
  const res = await json('POST', '/', { url: 'https://hooks.example.com/', events: ['comment.created'] })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id: 'w1', url: 'https://hooks.example.com/', secret: 'whsec_x' })
  expect(mocks.create).toHaveBeenCalledWith('alice', { url: 'https://hooks.example.com/', events: ['comment.created'] })
})

it('rejects unknown events and empty bodies before the registry sees them', async () => {
  expect((await json('POST', '/', { url: 'https://x.example.com/', events: ['nope'] })).status).toBe(400)
  expect((await json('POST', '/', { url: 'https://x.example.com/', events: [] })).status).toBe(400)
  expect((await json('PATCH', '/w1', {})).status).toBe(400)
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
})

it('turns a registry input error into a 400 with its message', async () => {
  mocks.create.mockRejectedValueOnce(new mocks.WebhookInputError('that address is private'))
  const res = await json('POST', '/', { url: 'http://localhost/', events: ['comment.created'] })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'that address is private' })
})

it('patches, rotates, tests and deletes by id, 404 when it is not yours', async () => {
  expect(await (await json('PATCH', '/w1', { enabled: false })).json()).toEqual({ id: 'w1', enabled: false })
  expect(mocks.update).toHaveBeenCalledWith('alice', 'w1', { enabled: false })
  expect(await (await json('POST', '/w1/rotate')).json()).toEqual({ secret: 'whsec_y' })
  expect(await (await json('POST', '/w1/test')).json()).toEqual({ ok: true, status: 200 })
  expect(await (await json('DELETE', '/w1')).json()).toEqual({ ok: true })
  mocks.remove.mockResolvedValueOnce(false)
  expect((await json('DELETE', '/w9')).status).toBe(404)
  mocks.rotate.mockResolvedValueOnce(undefined as unknown as string)
  expect((await json('POST', '/w9/rotate')).status).toBe(404)
})

it('hands a workspace limit to the registry, and a null one lifts it', async () => {
  await json('POST', '/', { url: 'https://hooks.example.com/', events: ['comment.created'], workspaceIds: ['ws-a'] })
  expect(mocks.create).toHaveBeenCalledWith('alice', {
    url: 'https://hooks.example.com/',
    events: ['comment.created'],
    workspaceIds: ['ws-a'],
  })
  expect((await json('PATCH', '/w1', { workspaceIds: null })).status).toBe(200)
  expect(mocks.update).toHaveBeenCalledWith('alice', 'w1', { workspaceIds: null })
  expect((await json('PATCH', '/w1', { workspaceIds: 'ws-a' })).status).toBe(400)
})

it('answers 400 with the registry’s message when it rejects a limit, on create and on patch', async () => {
  const message = 'that workspace does not exist, or you are not a member of it'
  mocks.create.mockRejectedValueOnce(new mocks.WebhookInputError(message))
  const created = await json('POST', '/', {
    url: 'https://hooks.example.com/',
    events: ['comment.created'],
    workspaceIds: ['ws-x'],
  })
  expect(created.status).toBe(400)
  expect(await created.json()).toEqual({ error: message })

  mocks.update.mockRejectedValueOnce(new mocks.WebhookInputError(message))
  const patched = await json('PATCH', '/w1', { workspaceIds: ['ws-x'] })
  expect(patched.status).toBe(400)
  expect(await patched.json()).toEqual({ error: message })
})

it('refuses a field it does not know, naming it, so a misspelled limit never means no limit', async () => {
  const created = await json('POST', '/', {
    url: 'https://hooks.example.com/',
    events: ['comment.created'],
    workspace_ids: ['ws-a'],
  })
  expect(created.status).toBe(400)
  expect((await created.json()).error).toContain('workspace_ids')
  const patched = await json('PATCH', '/w1', { enabled: true, workspace_ids: null })
  expect(patched.status).toBe(400)
  expect((await patched.json()).error).toContain('workspace_ids')
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
})
