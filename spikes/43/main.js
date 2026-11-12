// Scratch app for spike #43. MODE env selects the focus-free method (flags joined by '+').
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const flags = new Set((process.env.MODE || 'baseline').split('+'));
if (flags.has('accessory')) app.setActivationPolicy('accessory');
if (flags.has('prohibited')) app.setActivationPolicy('prohibited');
app.whenReady().then(() => {
  if (flags.has('dockhide')) app.dock.hide();
  const off = flags.has('offscreen');
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    x: off ? -5000 : undefined,
    y: off ? -5000 : undefined,
    show: !(flags.has('showinactive') || flags.has('hidden')),
    focusable: !flags.has('nofocusable'),
    webPreferences: { backgroundThrottling: !flags.has('nothrottle') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (flags.has('showinactive')) win.once('ready-to-show', () => win.showInactive());
});
app.on('window-all-closed', () => app.quit());
