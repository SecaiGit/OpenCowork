import { create } from 'zustand'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export interface LocalTerminalTab {
  id: string
  projectId: string | null
  title: string
  cwd: string
  shell: string
  createdAt: number
  status: 'running' | 'exited' | 'error'
  exitCode?: number
}

interface TerminalStore {
  tabs: LocalTerminalTab[]
  activeTabId: string | null
  initialized: boolean
  init: () => void
  createTab: (
    cwd?: string,
    title?: string,
    initialCommand?: string,
    projectId?: string | null
  ) => Promise<string | null>
  closeTab: (id: string) => Promise<void>
  setActiveTab: (id: string | null) => void
  findTabByCwd: (cwd?: string | null, projectId?: string | null) => LocalTerminalTab | null
  markExited: (id: string, exitCode?: number) => void
}

let subscribed = false

function buildNextTitle(
  tabs: LocalTerminalTab[],
  preferredTitle?: string,
  projectId?: string | null
): string {
  const baseTitle = preferredTitle?.trim() || 'Terminal'
  const normalizedProjectId = projectId ?? null
  const scopedTabs = tabs.filter((tab) => (tab.projectId ?? null) === normalizedProjectId)
  if (!scopedTabs.some((tab) => tab.title === baseTitle)) return baseTitle

  let nextIndex = 2
  while (scopedTabs.some((tab) => tab.title === `${baseTitle} ${nextIndex}`)) {
    nextIndex += 1
  }

  return `${baseTitle} ${nextIndex}`
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  initialized: false,
  init: () => {
    if (subscribed) {
      if (!get().initialized) set({ initialized: true })
      return
    }

    subscribed = true

    ipcClient.on(IPC.TERMINAL_EXIT, (payload) => {
      const data = payload as { id?: string; exitCode?: number }
      if (!data?.id) return
      get().markExited(data.id, data.exitCode)
    })

    set({ initialized: true })
  },
  createTab: async (cwd, preferredTitle, initialCommand, projectId) => {
    const title = buildNextTitle(get().tabs, preferredTitle, projectId)
    const result = (await ipcClient.invoke(IPC.TERMINAL_CREATE, {
      cwd,
      title
    })) as
      | {
          id?: string
          cwd?: string
          shell?: string
          createdAt?: number
          title?: string
          error?: string
        }
      | undefined

    if (!result?.id || result.error) {
      toast.error('Failed to create terminal', {
        description: result?.error || 'Unknown error'
      })
      return null
    }

    const tab: LocalTerminalTab = {
      id: result.id,
      projectId: projectId ?? null,
      title: result.title || title,
      cwd: result.cwd || cwd || '',
      shell: result.shell || '',
      createdAt: result.createdAt || Date.now(),
      status: 'running'
    }

    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id
    }))

    if (initialCommand && initialCommand.trim().length > 0) {
      const command = initialCommand.trim()
      setTimeout(() => {
        void ipcClient.invoke(IPC.TERMINAL_INPUT, {
          id: tab.id,
          data: `${command}\r`
        })
      }, 400)
    }

    return tab.id
  },
  closeTab: async (id) => {
    await ipcClient.invoke(IPC.TERMINAL_KILL, { id })
    set((state) => {
      const idx = state.tabs.findIndex((tab) => tab.id === id)
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      return {
        tabs,
        activeTabId:
          state.activeTabId === id
            ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
            : state.activeTabId
      }
    })
  },
  setActiveTab: (id) => set({ activeTabId: id }),
  findTabByCwd: (cwd, projectId) => {
    if (!cwd) return null
    const normalizedProjectId = projectId ?? null
    return (
      get().tabs.find(
        (tab) => tab.cwd === cwd && (tab.projectId ?? null) === normalizedProjectId
      ) ?? null
    )
  },
  markExited: (id, exitCode) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              status: exitCode === 0 ? 'exited' : 'error',
              exitCode
            }
          : tab
      )
    }))
}))
