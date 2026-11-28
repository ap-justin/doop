import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { loadIpAddressConfig } from '../server/auth.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import { startServer, type Server } from './harness.ts'

afterEach(unstubAllEnvs)

describe('loadIpAddressConfig', () => {
  it('leaves Better Auth on its default when nothing is set', () => {
    stubEnv('AUTH_IP_HEADERS', undefined)
    stubEnv('AUTH_TRUSTED_PROXIES', undefined)
    stubEnv('FLY_APP_NAME', undefined)
    expect(loadIpAddressConfig()).toBeNull()
  })

  it('passes lowercased headers and trusted proxies through', () => {
    stubEnv('AUTH_IP_HEADERS', 'Fly-Client-IP, X-Real-IP')
    stubEnv('AUTH_TRUSTED_PROXIES', '10.0.0.0/8')
    stubEnv('FLY_APP_NAME', undefined)
    expect(loadIpAddressConfig()).toEqual({
      ipAddressHeaders: ['fly-client-ip', 'x-real-ip'],
      trustedProxies: ['10.0.0.0/8'],
    })
  })
})

describe('loadIpAddressConfig on Fly', () => {
  it('reads Fly-Client-IP when FLY_APP_NAME is set and no header is configured', () => {
    stubEnv('AUTH_IP_HEADERS', undefined)
    stubEnv('AUTH_TRUSTED_PROXIES', undefined)
    stubEnv('FLY_APP_NAME', 'doop')
    expect(loadIpAddressConfig()).toEqual({ ipAddressHeaders: ['fly-client-ip'] })
  })

  it('lets AUTH_IP_HEADERS override the Fly default', () => {
    stubEnv('AUTH_IP_HEADERS', 'x-real-ip')
    stubEnv('AUTH_TRUSTED_PROXIES', undefined)
    stubEnv('FLY_APP_NAME', 'doop')
    expect(loadIpAddressConfig()).toEqual({ ipAddressHeaders: ['x-real-ip'] })
  })
})

describe('auth rate limiting behind a proxy', () => {
  let server: Server | undefined
  afterAll(() => server?.stop())

  it('limits each client by the configured header, not one shared bucket', async () => {
    server = await startServer({
      AUTH_IP_HEADERS: 'fly-client-ip',
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234',
    })
    const base = server.base
    const signIn = (ip: string) =>
      fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: base,
          'fly-client-ip': ip,
          /* two hops: on its own, Better Auth finds no client IP in this */
          'x-forwarded-for': `${ip}, 10.0.0.1`,
        },
        body: JSON.stringify({ email: 'someone@example.com', password: 'wrongpassword' }),
      })

    let limited = false
    for (let i = 0; i < 5 && !limited; i++) limited = (await signIn('203.0.113.10')).status === 429
    expect(limited).toBe(true)
    expect((await signIn('203.0.113.20')).status).not.toBe(429)
  }, 70_000)

  it('on Fly, limits by fly-client-ip and ignores a client-sent X-Forwarded-For', async () => {
    const fly = await startServer({
      FLY_APP_NAME: 'doop',
      AUTH_IP_HEADERS: '',
      AUTH_TRUSTED_PROXIES: '',
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234',
    })
    try {
      const signIn = (flyIp: string, forwarded: string) =>
        fetch(`${fly.base}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: fly.base,
            'fly-client-ip': flyIp,
            'x-forwarded-for': forwarded,
          },
          body: JSON.stringify({ email: 'someone@example.com', password: 'wrongpassword' }),
        })
      /* a varying forged X-Forwarded-For must not dodge the limit on one fly-client-ip */
      let limited = false
      for (let i = 0; i < 6 && !limited; i++)
        limited = (await signIn('203.0.113.30', `198.51.100.${i + 1}`)).status === 429
      expect(limited).toBe(true)
      expect((await signIn('203.0.113.40', '198.51.100.1')).status).not.toBe(429)
    } finally {
      fly.stop()
    }
  }, 70_000)
})
