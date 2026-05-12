import { app } from 'electron'

const APP_NAME = 'OpenCowork'
const USER_AGENT_HEADER = 'user-agent'

export function getDefaultApiUserAgent(): string {
  const version = app.getVersion().trim()
  return version ? `${APP_NAME}/${version}` : APP_NAME
}

export function hasUserAgentHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === USER_AGENT_HEADER)
}

export function applyDefaultApiUserAgent(headers: Record<string, string>): Record<string, string> {
  if (!hasUserAgentHeader(headers)) {
    headers['User-Agent'] = getDefaultApiUserAgent()
  }
  return headers
}
