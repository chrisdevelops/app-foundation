import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('spike', {
  probe: () => ({
    processType: process.type,
    hasRequire: typeof require !== 'undefined',
    sandboxed: process.sandboxed,
  }),
})
