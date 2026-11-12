



export async function runSqlite(): Promise<unknown> {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  db.exec('create table t (id integer primary key, name text)')
  db.prepare('insert into t (name) values (?)').run('alpha')
  db.prepare('insert into t (name) values (?)').run('beta')
  const rows = db.prepare('select id, name from t order by id').all()
  const version = (db.prepare('select sqlite_version() as v').get() as { v: string }).v
  db.close()
  return { rows, sqliteVersion: version }
}

export async function runSharp(): Promise<unknown> {
  const { default: sharp } = await import('sharp')
  const input = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer()
  const out = await sharp(input).resize(16, 16).png().toBuffer()
  const meta = await sharp(out).metadata()
  return { inputBytes: input.length, outputBytes: out.length, width: meta.width, height: meta.height, format: meta.format, libvips: sharp.versions.vips }
}

export async function runPty(): Promise<unknown> {
  const pty = await import('node-pty')
  return new Promise((resolve, reject) => {
    const term = pty.spawn('/bin/sh', ['-c', 'echo pty-hello-$((6*7))'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: '/',
      env: process.env as Record<string, string>,
    })
    let output = ''
    const timer = setTimeout(() => reject(new Error('pty timeout; output so far: ' + JSON.stringify(output))), 8000)
    term.onData((d) => {
      output += d
    })
    term.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve({ output, exitCode, pid: term.pid })
    })
  })
}
