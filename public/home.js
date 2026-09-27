// @ts-check
import { element } from './element.js'

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sept',
  'Oct',
  'Nov',
  'Dec'
]
const WEEKDAYS = ['Sun', 'Mon', 'Tues', 'Weds', 'Thur', 'Fri', 'Sat']
const ADJECTIVES = [
  'autumn',
  'bold',
  'calm',
  'crimson',
  'damp',
  'dawn',
  'delicate',
  'frosty',
  'gentle',
  'golden',
  'hidden',
  'lively',
  'misty',
  'quiet',
  'rapid',
  'silent',
  'snowy',
  'spring',
  'summer',
  'wild'
]
const NOUNS = [
  'bird',
  'breeze',
  'brook',
  'cloud',
  'dew',
  'field',
  'fire',
  'forest',
  'glade',
  'haze',
  'lake',
  'leaf',
  'meadow',
  'moon',
  'pine',
  'river',
  'sea',
  'star',
  'sun',
  'wave'
]

const clock = element('clock', HTMLTimeElement)
const form = element('join-form', HTMLFormElement)
const nameInput = element('room-name', HTMLInputElement)

function showTime() {
  const now = new Date()
  const hour = now.getHours() % 12 || 12
  const minute = String(now.getMinutes()).padStart(2, '0')
  const ampm = now.getHours() >= 12 ? 'PM' : 'AM'
  const weekday = WEEKDAYS[now.getDay()]
  const month = MONTHS[now.getMonth()]
  clock.dateTime = now.toISOString()
  clock.textContent = `${hour}:${minute} ${ampm}\u00a0 • \u00a0${weekday}, \u00a0${month} ${now.getDate()}`
}

/** @param {string[]} words */
const pick = (words) => words[Math.floor(Math.random() * words.length)]

showTime()
setInterval(showTime, 1000)

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const name =
    nameInput.value.trim().toLowerCase() || `${pick(ADJECTIVES)}-${pick(NOUNS)}`
  location.assign(`/room/${encodeURIComponent(name)}`)
})
