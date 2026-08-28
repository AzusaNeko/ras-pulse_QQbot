import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, BulkSubscriptionPatch, MercariItem, MonitorEvent, NewSubscription, QQCommandPanelSyncResult, SaveQQBotConfigInput, Subscription } from '../shared/types'

contextBridge.exposeInMainWorld('mercariPulse', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getSnapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  addSubscription: (input: NewSubscription) => ipcRenderer.invoke('monitor:add', input),
  updateSubscription: (id: string, patch: Partial<Subscription>) => ipcRenderer.invoke('monitor:update', id, patch),
  updateAllSubscriptions: (patch: BulkSubscriptionPatch) => ipcRenderer.invoke('monitor:update-all', patch),
  removeSubscription: (id: string, removeRelatedItems: boolean) => ipcRenderer.invoke('monitor:remove', id, removeRelatedItems),
  dismissRecentItem: (subscriptionId: string, itemId: string) => ipcRenderer.invoke('monitor:dismiss-item', subscriptionId, itemId),
  addFavorite: (item: MercariItem) => ipcRenderer.invoke('favorites:add', item),
  removeFavorite: (itemId: string) => ipcRenderer.invoke('favorites:remove', itemId),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  checkNow: (id: string) => ipcRenderer.invoke('monitor:check-now', id),
  checkAllNow: () => ipcRenderer.invoke('monitor:check-all-now'),
  testNotification: () => ipcRenderer.invoke('notifications:test'),
  getQQBotConfig: () => ipcRenderer.invoke('qqbot:get-config'),
  saveQQBotConfig: (input: SaveQQBotConfigInput) => ipcRenderer.invoke('qqbot:save-config', input),
  testQQBot: (botId: string) => ipcRenderer.invoke('qqbot:test', botId),
  syncQQCommandPanels: (botId: string): Promise<QQCommandPanelSyncResult> => ipcRenderer.invoke('qqbot:sync-command-panels', botId),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  onMonitorEvent: (listener: (event: MonitorEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: MonitorEvent): void => listener(value)
    ipcRenderer.on('monitor:event', handler)
    return () => ipcRenderer.removeListener('monitor:event', handler)
  }
})
