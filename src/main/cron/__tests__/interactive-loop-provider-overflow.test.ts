import { createServer, type Server, type ServerResponse } from 'http'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/tmp/opencowork-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false
  }
}))

import { runInteractiveAgentLoop } from '../cron-agent-background'

type InteractiveLoopMessages = Parameters<typeof runInteractiveAgentLoop>[0]
type InteractiveLoopConfig = Parameters<typeof runInteractiveAgentLoop>[1]
type CapturedEvent = { type?: string; [key: string]: unknown }

function overflowRecoveryMessages(): InteractiveLoopMessages {
  return [
    {
      id: 'old-user',
      role: 'user',
      content: 'old task context',
      createdAt: 1
    },
    {
      id: 'old-tool-use',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'old-tool', name: 'Read', input: { file: 'old.txt' } }],
      createdAt: 2
    },
    {
      id: 'old-tool-result',
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'old-tool', content: 'old result payload' }],
      createdAt: 3
    },
    {
      id: 'old-assistant',
      role: 'assistant',
      content: 'old task done',
      createdAt: 4
    },
    {
      id: 'current-user',
      role: 'user',
      content: 'current task anchor',
      createdAt: 5
    }
  ]
}

function contextCompression(): NonNullable<InteractiveLoopConfig['contextCompression']> {
  return {
    config: {
      enabled: true,
      contextLength: 100_000,
      threshold: 0.8,
      reservedOutputBudget: 2_000
    }
  }
}

async function startProviderServer(
  handleRequest: (args: { attempt: number; body: string; res: ServerResponse }) => void
): Promise<{
  baseUrl: string
  requestBodies: string[]
  close: () => Promise<void>
}> {
  const requestBodies: string[] = []
  let attempt = 0
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      attempt += 1
      const body = Buffer.concat(chunks).toString('utf8')
      requestBodies.push(body)
      handleRequest({ attempt, body, res })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to start test provider server')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestBodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
  }
}

function writeOpenAIChatTextResponse(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  if (text) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  }
  res.write(
    `data: ${JSON.stringify({
      choices: [{ finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: text ? 1 : 0 }
    })}\n\n`
  )
  res.end('data: [DONE]\n\n')
}

async function runLoopAgainstProvider(baseUrl: string): Promise<unknown[]> {
  return runLoopWithMessages({
    baseUrl,
    messages: overflowRecoveryMessages(),
    compression: contextCompression()
  })
}

async function runLoopWithMessages(args: {
  baseUrl: string
  messages: InteractiveLoopMessages
  compression: NonNullable<InteractiveLoopConfig['contextCompression']>
  captureFinalMessages?: boolean
}): Promise<CapturedEvent[]> {
  const abortController = new AbortController()
  const events: CapturedEvent[] = []
  const timeout = setTimeout(() => abortController.abort(), 3_000)

  try {
    for await (const event of runInteractiveAgentLoop(
      args.messages,
      {
        maxIterations: 1,
        provider: {
          type: 'openai-chat',
          apiKey: 'test-key',
          model: 'test-model',
          baseUrl: args.baseUrl
        },
        tools: [],
        signal: abortController.signal,
        contextCompression: args.compression,
        ...(args.captureFinalMessages ? { captureFinalMessages: true } : {})
      },
      {
        sessionId: 'session-1',
        workingFolder: 'C:/projects/OpenCowork',
        signal: abortController.signal
      }
    )) {
      events.push(event)
      if (event.type === 'loop_end') break
    }
  } finally {
    clearTimeout(timeout)
  }

  return events
}

describe('main interactive agent loop provider overflow recovery', () => {
  it('shrinks history and retries once when the provider reports context overflow before streaming', async () => {
    const server = await startProviderServer(({ attempt, res }) => {
      if (attempt === 1) {
        res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' })
        res.end('maximum context length exceeded')
        return
      }
      writeOpenAIChatTextResponse(res, 'continued after overflow recovery')
    })

    try {
      const events = await runLoopAgainstProvider(server.baseUrl)

      if (server.requestBodies.length !== 2) {
        throw new Error(
          `expected two provider requests, got ${server.requestBodies.length}; events=${JSON.stringify(events)}`
        )
      }
      expect(server.requestBodies[1]).toContain('current task anchor')
      expect(server.requestBodies[1]).not.toContain('old result payload')
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'context_compression_deferred',
            reason: 'hard_context_limit_exceeded',
            blockingNextRequest: false,
            messagesChanged: true
          }),
          expect.objectContaining({
            type: 'text_delta',
            text: 'continued after overflow recovery'
          }),
          expect.objectContaining({ type: 'loop_end', reason: 'completed' })
        ])
      )
      expect(events).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'error' })])
      )
    } finally {
      await server.close()
    }
  })

  it('fails instead of completing with an empty assistant after overflow recovery', async () => {
    const server = await startProviderServer(({ attempt, res }) => {
      if (attempt === 1) {
        res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' })
        res.end('maximum context length exceeded')
        return
      }
      writeOpenAIChatTextResponse(res, '')
    })

    try {
      const events = await runLoopAgainstProvider(server.baseUrl)

      if (server.requestBodies.length !== 2) {
        throw new Error(
          `expected two provider requests, got ${server.requestBodies.length}; events=${JSON.stringify(events)}`
        )
      }
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            errorType: 'hard_context_limit_exceeded'
          }),
          expect.objectContaining({ type: 'loop_end', reason: 'error' })
        ])
      )
      expect(events).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'loop_end', reason: 'completed' })])
      )
    } finally {
      await server.close()
    }
  })

  it('settles a streamed tool call with an error result when the provider fails mid-stream', async () => {
    const server = await startProviderServer(({ res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'main-stream-tool'
                  }
                ]
              }
            }
          ]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      name: 'Read'
                    }
                  }
                ]
              }
            }
          ]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: '{"file_path":"src/app.ts"}'
                    }
                  }
                ]
              }
            }
          ]
        })}\n\n`
      )
      setTimeout(() => {
        res.destroy(new Error('context length exceeded after streaming tool call'))
      }, 10)
    })

    try {
      const events = await runLoopWithMessages({
        baseUrl: server.baseUrl,
        messages: [
          {
            id: 'current-user',
            role: 'user',
            content: 'read file',
            createdAt: 1
          }
        ],
        compression: contextCompression(),
        captureFinalMessages: true
      })

      expect(server.requestBodies).toHaveLength(1)
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_use_streaming_start',
            toolCallId: 'main-stream-tool'
          }),
          expect.objectContaining({
            type: 'tool_call_result',
            toolCall: expect.objectContaining({
              id: 'main-stream-tool',
              status: 'error'
            })
          }),
          expect.objectContaining({
            type: 'iteration_end',
            toolResults: expect.arrayContaining([
              expect.objectContaining({ toolUseId: 'main-stream-tool', isError: true })
            ])
          }),
          expect.objectContaining({ type: 'loop_end', reason: 'error' })
        ])
      )
      const loopEnd = events.find((event) => event.type === 'loop_end')
      expect(JSON.stringify(loopEnd?.messages)).toContain('main-stream-tool')
      expect(JSON.stringify(loopEnd?.messages)).toContain('"isError":true')
    } finally {
      await server.close()
    }
  })

  it('restores externalized user input in captured final messages', async () => {
    const rawContent = 'main-sidecar-raw-input\n'.repeat(1_000)
    const server = await startProviderServer(({ res }) => {
      writeOpenAIChatTextResponse(res, 'continued after preflight guard')
    })

    try {
      const events = await runLoopWithMessages({
        baseUrl: server.baseUrl,
        messages: [
          {
            id: 'huge-user',
            role: 'user',
            content: rawContent,
            createdAt: 1
          }
        ],
        compression: {
          config: {
            enabled: true,
            contextLength: 1_000,
            threshold: 0.8,
            reservedOutputBudget: 200
          }
        },
        captureFinalMessages: true
      })

      expect(server.requestBodies).toHaveLength(1)
      expect(server.requestBodies[0]).toContain('[User input externalized for context budget]')
      expect(server.requestBodies[0]).not.toContain(
        'main-sidecar-raw-input\nmain-sidecar-raw-input'
      )

      const loopEnd = events.find((event) => event.type === 'loop_end')
      expect(loopEnd).toMatchObject({ type: 'loop_end', reason: 'completed' })
      const finalMessages = loopEnd?.messages as InteractiveLoopMessages | undefined
      expect(finalMessages?.[0]?.content).toBe(rawContent)
      expect(JSON.stringify(finalMessages)).not.toContain(
        '[User input externalized for context budget]'
      )
    } finally {
      await server.close()
    }
  })
})
