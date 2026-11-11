import { greeting } from '@spike/greeting'

declare global {
  interface Window {
    spike: { probe: () => { processType: string; hasRequire: boolean; sandboxed: boolean | undefined } }
  }
}

const probe = window.spike.probe()
const info = {
  greeting: greeting("renderer"),
  preload: probe,
  rendererHasRequire: typeof (globalThis as { require?: unknown }).require !== 'undefined',
  rendererHasProcess: typeof (globalThis as { process?: unknown }).process !== 'undefined',
}
document.getElementById('out')!.textContent = JSON.stringify(info)
console.log('SPIKE_RENDERER ' + JSON.stringify(info))
