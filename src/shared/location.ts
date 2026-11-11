import type { KbLocation } from './protocol'

export function formatKbLocation(location: KbLocation): string {
  if (typeof location.page === 'number') {
    return `第 ${location.page} 页`
  }
  if (typeof location.paragraph === 'number') {
    return `第 ${location.paragraph} 段`
  }
  if (typeof location.handle === 'string') {
    return `句柄 #${location.handle}`
  }
  if (typeof location.row === 'number') {
    return `第 ${location.row} 行`
  }
  if (typeof location.region === 'string') {
    return `识别${location.region}`
  }
  return Object.entries(location)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ')
}
