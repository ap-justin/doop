import { createServer, type Server } from 'node:net'

export interface SinkMail {
  to: string
  data: string
}

/** A minimal SMTP server that accepts every message and keeps it, so a test
 *  can read what a server mailed (an invite link, say). */
export async function startSmtpSink(): Promise<{
  port: number
  mails: SinkMail[]
  stop: () => Promise<void>
}> {
  const mails: SinkMail[] = []
  const server: Server = createServer((socket) => {
    let to = ''
    let body: string[] | null = null
    let buffer = ''
    socket.write('220 sink ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let eol: number
      while ((eol = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        if (body) {
          if (line === '.') {
            mails.push({ to, data: body.join('\n').replace(/=\n/g, '').replace(/=3D/g, '=') })
            body = null
            socket.write('250 queued\r\n')
          } else body.push(line.startsWith('..') ? line.slice(1) : line)
          continue
        }
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 sink\r\n')
        else if (verb === 'MAIL') socket.write('250 ok\r\n')
        else if (verb === 'RCPT') {
          to = /<([^>]*)>/.exec(line)?.[1] ?? ''
          socket.write('250 ok\r\n')
        } else if (verb === 'DATA') {
          body = []
          socket.write('354 go\r\n')
        } else if (verb === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { port, mails, stop: () => new Promise((resolve) => server.close(() => resolve())) }
}
