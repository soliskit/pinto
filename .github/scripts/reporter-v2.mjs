// Prototype v2: fd 3 protocol = READY handshake, then FIRST-FAIL <json name>.
// Fatal semantics unchanged from the reviewed v1 (todo/skip top-level fields,
// presence-based, {failing:true} fatal on Node 26.13.0). Yields nothing but
// one empty chunk; silent when fd 3 is closed.
import { writeSync } from 'node:fs'

const say = (line) => {
  try {
    writeSync(3, line)
    return true
  } catch {
    return false
  }
}

export default async function* firstFailReporter(source) {
  say('READY\n')
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.todo === undefined && event.data.skip === undefined) {
      say(`FIRST-FAIL ${JSON.stringify(event.data.name ?? null)}\n`)
      yield ''
      return
    }
  }
}
