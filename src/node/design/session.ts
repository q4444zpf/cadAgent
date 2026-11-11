import { ParameterListSchema } from '../../shared/protocol'
import type { DesignSessionView, ParameterList } from '../../shared/protocol'

export type ConfirmResult =
  | { ok: true; session: DesignSessionView }
  | { ok: false; error: string }

export type CancelResult = { ok: true } | { ok: false; error: string }

export class DesignSessionStore {
  private readonly sessions = new Map<string, DesignSessionView>()

  create(list: ParameterList): DesignSessionView {
    const parsed = ParameterListSchema.parse(list)
    const session: DesignSessionView = { list: parsed, status: 'draft' }
    this.sessions.set(parsed.id, session)
    return clone(session)
  }

  get(listId: string): DesignSessionView | null {
    const session = this.sessions.get(listId)
    return session ? clone(session) : null
  }

  confirm(listId: string, values: Record<string, string>): ConfirmResult {
    const session = this.sessions.get(listId)
    if (!session) {
      return { ok: false, error: '参数清单不存在' }
    }
    if (session.status === 'confirmed') {
      return { ok: false, error: '参数清单已确认' }
    }
    if (session.status === 'cancelled') {
      return { ok: false, error: '参数清单已取消' }
    }

    const updates = new Map<string, string>()
    for (const [id, raw] of Object.entries(values)) {
      const parameter = session.list.parameters.find((item) => item.id === id)
      if (!parameter) {
        return { ok: false, error: `未知参数：${id}` }
      }
      const value = raw.trim()
      if (!value) {
        return { ok: false, error: `参数「${parameter.name}」的值不能为空` }
      }
      updates.set(id, value)
    }

    const parameters = session.list.parameters.map((parameter) =>
      updates.has(parameter.id)
        ? { ...parameter, value: updates.get(parameter.id) as string }
        : parameter
    )
    const confirmed: DesignSessionView = {
      list: { ...session.list, parameters },
      status: 'confirmed',
      confirmedValues: Object.fromEntries(
        parameters.map((parameter) => [parameter.id, parameter.value])
      )
    }
    this.sessions.set(listId, confirmed)
    return { ok: true, session: clone(confirmed) }
  }

  cancel(listId: string): CancelResult {
    const session = this.sessions.get(listId)
    if (!session) {
      return { ok: false, error: '参数清单不存在' }
    }
    if (session.status !== 'draft') {
      return { ok: false, error: '仅待确认的参数清单可取消' }
    }
    this.sessions.set(listId, { ...session, status: 'cancelled' })
    return { ok: true }
  }
}

function clone(session: DesignSessionView): DesignSessionView {
  return {
    list: {
      ...session.list,
      parameters: session.list.parameters.map((parameter) => ({ ...parameter }))
    },
    status: session.status,
    ...(session.confirmedValues ? { confirmedValues: { ...session.confirmedValues } } : {})
  }
}
