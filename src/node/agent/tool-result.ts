export function success(details: unknown): {
  content: { type: 'text'; text: string }[]
  details: unknown
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details
  }
}

export function failure(message: string): {
  content: { type: 'text'; text: string }[]
  details: { error: string }
  isError: true
} {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
    isError: true
  }
}
