import { describe, expect, it } from 'vitest'
import { DesignSessionStore } from '../../src/node/design/session'
import type { ParameterList } from '../../src/shared/protocol'

function list(overrides: Partial<ParameterList> = {}): ParameterList {
  return {
    id: 'list-1',
    title: '排水沟典型断面',
    drawingType: '排水沟',
    summary: '依据规范与历史图纸整理',
    parameters: [
      {
        id: 'width',
        name: '净宽',
        value: '600',
        unit: 'mm',
        basis: 'spec.pdf·第 2 页',
        assumed: false
      },
      {
        id: 'wall',
        name: '壁厚',
        value: '100',
        unit: 'mm',
        basis: '假设：按常规构造取值，待结构校核',
        assumed: true
      }
    ],
    ...overrides
  }
}

describe('DesignSessionStore', () => {
  it('keeps a proposed parameter list in draft with its original values', () => {
    const store = new DesignSessionStore()

    const session = store.create(list())

    expect(session.status).toBe('draft')
    expect(session.list.parameters.map((parameter) => parameter.value)).toEqual(['600', '100'])
    expect(store.get('list-1')?.status).toBe('draft')
  })

  it('applies edited values on confirm and exposes them for generation', () => {
    const store = new DesignSessionStore()
    store.create(list())

    const result = store.confirm('list-1', { width: ' 800 ' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.session.status).toBe('confirmed')
    expect(result.session.list.parameters[0].value).toBe('800')
    expect(result.session.list.parameters[1].value).toBe('100')
    expect(result.session.confirmedValues).toEqual({ width: '800', wall: '100' })
    expect(store.get('list-1')?.status).toBe('confirmed')
  })

  it('rejects unknown or empty edits and stays draft', () => {
    const store = new DesignSessionStore()
    store.create(list())

    expect(store.confirm('list-1', { missing: '1' })).toEqual({
      ok: false,
      error: '未知参数：missing'
    })
    expect(store.confirm('list-1', { width: '   ' })).toEqual({
      ok: false,
      error: '参数「净宽」的值不能为空'
    })
    expect(store.get('list-1')?.status).toBe('draft')
  })

  it('cancel discards confirmation and blocks later confirmation', () => {
    const store = new DesignSessionStore()
    store.create(list())

    expect(store.cancel('list-1')).toEqual({ ok: true })
    expect(store.get('list-1')?.status).toBe('cancelled')
    expect(store.get('list-1')?.confirmedValues).toBeUndefined()
    expect(store.confirm('list-1', { width: '800' })).toEqual({
      ok: false,
      error: '参数清单已取消'
    })
  })

  it('rejects duplicate confirmation', () => {
    const store = new DesignSessionStore()
    store.create(list())
    store.confirm('list-1', {})

    expect(store.confirm('list-1', {})).toEqual({
      ok: false,
      error: '参数清单已确认'
    })
  })

  it('returns null for an unknown list', () => {
    const store = new DesignSessionStore()

    expect(store.get('missing')).toBeNull()
    expect(store.cancel('missing')).toEqual({ ok: false, error: '参数清单不存在' })
  })
})
