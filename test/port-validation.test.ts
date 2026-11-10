import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Runs src/index.ts with the given environment until it exits */
function runServer(
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        KEY: '',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_AUTH_TOKEN: '',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      output += data
    })
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      output += data
    })
    child.on('error', reject)
    const killer = setTimeout(() => {
      child.kill()
      reject(new Error(`server did not exit. Output:\n${output}`))
    }, 10_000)
    child.on('exit', (code) => {
      clearTimeout(killer)
      resolve({ code, output })
    })
  })
}

// A bad configured port fails with a clear message (owner rule, November 4,
// 2026); an unconfigured local port is reported clearly rather than silently
// defaulting (owner decision, November 2, 2026). The 443 fallback itself is
// pinned by test/default-ports.test.ts.
void describe('port validation', () => {
  for (const value of ['abc', '0', '-1', '70000', '3.5']) {
    void test(`PORT=${value} exits 1 with a clear message`, async () => {
      const { code, output } = await runServer({ PORT: value })
      assert.equal(code, 1, `output:\n${output}`)
      assert.match(
        output,
        new RegExp(`PORT=${value.replace(/[.]/g, '\\.')} is not a port number`),
        `output:\n${output}`
      )
    })
  }

  void test('an unset PORT keeps the 443 fallback and says so', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KEY: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: ''
    }
    delete env.PORT
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      output += data
    })
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      output += data
    })
    try {
      const deadline = Date.now() + 10_000
      // Serving on 443 is pinned by test/default-ports.test.ts; here the
      // fallback target and the notice matter. In a sandbox that cannot
      // bind 443 the server names 443 in its listen-failure instead.
      while (
        !output.includes('Pinto listening on http://localhost:443') &&
        !output.includes('Pinto cannot listen on port 443:')
      ) {
        if (Date.now() > deadline) {
          assert.fail(`server never tried port 443. Output:\n${output}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.match(output, /PORT is not set/, `output:\n${output}`)
    } finally {
      child.kill()
    }
  })
})
