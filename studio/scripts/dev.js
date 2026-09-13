// Starts the FastAPI backend (if not already up) + Vite dev server.
// CLI args (e.g. --port/--host from Kimi Work) are forwarded to Vite.
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = path.join(root, 'server')
const py = path.join(serverDir, '.venv', 'bin', 'python')

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.end(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

if (!(await portOpen(8765))) {
  const backend = spawn(py, ['main.py'], { cwd: serverDir, stdio: 'inherit' })
  backend.on('exit', (code) => console.log(`[backend] exited (${code})`))
  await new Promise((r) => setTimeout(r, 1500))
} else {
  console.log('[backend] already running on :8765')
}

const vite = spawn(path.join(root, 'node_modules', '.bin', 'vite'), process.argv.slice(2), {
  cwd: root,
  stdio: 'inherit',
})
vite.on('exit', (code) => process.exit(code ?? 0))
