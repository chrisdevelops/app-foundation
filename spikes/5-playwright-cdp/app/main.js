let n = 0
document.getElementById('inc').addEventListener('click', () => { document.getElementById('count').textContent = String(++n) })
document.getElementById('open-wo').addEventListener('click', () => { window.open('child.html', '_blank') })
document.getElementById('open-bw').addEventListener('click', () => { void window.spike.openBrowserWindow() })
document.getElementById('quit').addEventListener('click', () => { void window.spike.quit() })
