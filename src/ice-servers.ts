export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

const PUBLIC_STUN: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN

let cache: { servers: IceServer[]; expiresAt: number } | undefined

/**
 * STUN and TURN servers for the browser's RTCPeerConnection. With Twilio
 * credentials set, returns Twilio's servers, which include TURN relays so
 * calls also connect on strict networks. Otherwise, or if Twilio fails,
 * falls back to a public STUN server.
 */
export async function getIceServers(): Promise<IceServer[]> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return PUBLIC_STUN
  if (cache && cache.expiresAt > Date.now()) return cache.servers

  try {
    const credentials = Buffer.from(
      `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
    ).toString('base64')
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Tokens.json`,
      { method: 'POST', headers: { Authorization: `Basic ${credentials}` } }
    )
    if (!response.ok) {
      throw Error(`Twilio responded with ${response.status}`)
    }
    const token = (await response.json()) as {
      ice_servers: IceServer[]
      ttl: string
    }
    const servers = token.ice_servers.map(({ urls, username, credential }) => ({
      urls,
      username,
      credential
    }))
    // TURN credentials expire after `ttl` seconds, so refresh at half of it
    cache = { servers, expiresAt: Date.now() + Number(token.ttl) * 500 }
    return servers
  } catch (error) {
    console.error('Could not get ICE servers from Twilio', error)
    return PUBLIC_STUN
  }
}
