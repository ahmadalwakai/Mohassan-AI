import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BrowserLiveViewWindowState } from './browser-live-view-window';

/** Shell identity and the native bounds bridge for the trusted browser live view. */
contextBridge.exposeInMainWorld('mohassanDesktop', Object.freeze({
  shell: 'electron',
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  browserLiveView: {
    enabled: (): Promise<boolean> => ipcRenderer.invoke('browser-live-view:enabled'),
    onEnabledChanged: (listener: (enabled: boolean) => void) => {
      const wrapped = (_event: IpcRendererEvent, enabled: boolean) => listener(enabled);
      ipcRenderer.on('browser-live-view:enabled-changed', wrapped);
      return () => { ipcRenderer.removeListener('browser-live-view:enabled-changed', wrapped); };
    },
    update: (state: BrowserLiveViewWindowState): Promise<void> => ipcRenderer.invoke('browser-live-view:update', state),
    cornerAt: (point: { x: number; y: number }): Promise<BrowserLiveViewWindowState['corner'] | null> => (
      ipcRenderer.invoke('browser-live-view:corner-at', point)
    ),
  },
}));
