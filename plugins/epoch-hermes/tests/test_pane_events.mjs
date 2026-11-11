// Exercise the shipped ESM without installing React or the Desktop SDK.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const tick = async () => { await Promise.resolve(); await Promise.resolve() }

async function harness({ badges = true, events = true } = {}) {
  const handlers = new Map(), disposal = [], requests = [], navigated = [], saved = new Map(), contributions = new Map()
  const states = [], effects = [], pendingEffects = []
  let cursor = 0, tree, page
  const hook = init => {
    const i = cursor++
    if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
    return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
  }
  const effect = (fn, deps) => {
    const i = cursor++
    if (!effects[i] || deps.some((v, j) => v !== effects[i].deps[j])) {
      pendingEffects.push(() => {
        effects[i]?.drop?.()
        effects[i] = { deps, drop: fn() }
      })
    }
  }
  const react = { useState: hook, useRef: v => hook(() => ({ current: v }))[0],
    useMemo: fn => { cursor++; return fn() }, useEffect: effect, useLayoutEffect: effect }
  const jsx = (type, props) => ({ type, props })
  const host = { navigate: path => navigated.push(path) }
  if (events) host.onEvent = (name, cb) => { handlers.set(name, cb); return () => handlers.delete(name) }
  const sdk = { host, ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav',
    KANBAN_CARD_AREAS: badges ? { badges: 'badges' } : undefined }
  const ctx = {
    onDispose: fn => disposal.push(fn),
    registerMany: entries => { page = entries.find(e => e.id === 'page').render },
    register: entry => {
      contributions.set(entry.id, entry)
      return () => { if (contributions.get(entry.id) === entry) contributions.delete(entry.id) }
    }, setInterval: () => {},
    storage: { get: (key, fallback) => saved.get(key) ?? fallback, set: (key, value) => saved.set(key, value) },
    rest: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
  }
  const context = vm.createContext({ document: { createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} }, hidden: false } })
  const mod = new vm.SourceTextModule(await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8'), { context })
  const modules = { '@hermes/plugin-sdk': sdk, react, 'react/jsx-runtime': { jsx, jsxs: jsx } }
  await mod.link(name => {
    const exports = modules[name]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await mod.evaluate()
  mod.namespace.default.register(ctx)
  const render = () => {
    cursor = 0
    const el = page()
    tree = el.type(el.props)
    for (const run of pendingEffects.splice(0)) run()
    return tree
  }
  const emit = (name, payload) => handlers.get(`plugin.epoch.${name}`)?.({ payload })
  const walk = node => !node || typeof node !== 'object' ? []
    : [node, ...[node.props?.children].flat(Infinity).flatMap(child => walk(child))]
  return { ctx, requests, navigated, emit, render, saved, handlers, contributions, nodes: () => walk(tree),
    unmount: () => { for (const e of effects) e?.drop?.() },
    remount: () => { states.length = 0; effects.length = 0; pendingEffects.length = 0; render() },
    dispose: () => { for (const fn of disposal) fn() } }
}

test('show opens the route before mount, replays view/card, and cleans up on unload', async () => {
  const h = await harness({ badges: false })
  h.emit('view.set', { view: 'dots', item_id: 't_b' })
  assert.deepEqual(h.navigated, ['/epoch'])
  h.render()
  h.requests.find(r => r.path === '/tasks').resolve({ tasks: [
    { board: 'default', id: 't_a', title: 'A', hint: {} },
    { board: 'default', id: 't_b', title: 'B', hint: {} },
  ] })
  await tick(); h.render()
  assert.equal(h.saved.get('chart').view, 'dots')
  assert.equal(h.nodes().find(n => n.type === 'select').props.value, 'default\u0000t_b')
  assert.ok(h.requests.some(r => r.path.includes('task_id=t_b')))
  h.unmount()
  const count = h.requests.length
  h.emit('data.updated', {})
  assert.equal(h.requests.length, count)
  h.dispose()
  assert.equal(h.handlers.size, 0)
})

test('live refresh beats old tasks, history, forecast and badge requests', async () => {
  const h = await harness()
  h.render()
  const firstTasks = h.requests.find(r => r.path === '/tasks')
  const firstHistory = h.requests.find(r => r.path === '/history')
  const firstBadges = h.requests.find(r => r.path === '/badges')
  firstTasks.resolve({ tasks: [{ board: 'default', id: 't_a', title: 'A', hint: {} }] })
  await tick(); h.render()
  const oldForecast = h.requests.find(r => r.path.startsWith('/forecast'))
  h.emit('view.set', { view: 'cdf', item_id: 't_b' })
  h.render()
  const freshTasks = h.requests.filter(r => r.path === '/tasks').at(-1)
  freshTasks.resolve({ tasks: [{ board: 'default', id: 't_b', title: 'B', hint: {} }] })
  await tick(); h.render()
  const freshForecast = h.requests.filter(r => r.path.startsWith('/forecast')).at(-1)
  freshForecast.resolve({ ok: true, percentiles_days: { p50: 1, p90: 2 }, iterations: 5000 })
  h.requests.filter(r => r.path === '/history').at(-1).resolve({ items: [{ name: 'fresh history' }] })
  h.requests.filter(r => r.path === '/badges').at(-1).resolve({ tasks: { t_b: { p50_hours: 8, p90_hours: 16 } } })
  await tick()
  oldForecast.resolve({ ok: false, error: 'stale forecast' })
  firstHistory.resolve({ items: [{ name: 'stale history' }] })
  firstBadges.resolve({ tasks: { t_b: { p50_hours: 800, p90_hours: 1600 } } })
  await tick(); h.render()
  assert.ok(h.nodes().some(n => n.props?.className === 'ep-lead'))
  assert.ok(!h.nodes().some(n => n.props?.children === 'stale forecast'))
  assert.equal(h.nodes().find(n => n.type?.name === 'History').props.items[0].name, 'fresh history')
  assert.equal(h.contributions.get('estimate').data.decorate({ id: 't_b' }).label, 'P50 1.0d · P90 2.0d')
  assert.equal(h.saved.get('chart').view, 'cdf')
  assert.equal(h.nodes().find(n => n.type === 'select').props.value, 'default\u0000t_b')

  h.emit('data.updated', {})
  h.render()
  const staleTasks = h.requests.filter(r => r.path === '/tasks').at(-1)
  h.emit('data.updated', {})
  h.render()
  const newerTasks = h.requests.filter(r => r.path === '/tasks').at(-1)
  newerTasks.resolve({ tasks: [{ board: 'default', id: 't_b', title: 'new', hint: {} }] })
  staleTasks.resolve({ tasks: [{ board: 'default', id: 't_a', title: 'stale', hint: {} }] })
  await tick(); h.render()
  assert.equal(h.nodes().find(n => n.type === 'option').props.children, 'new')
  h.unmount(); h.dispose()
})

test('Refresh refetches the selected card forecast after its hint changes', async () => {
  const h = await harness({ badges: false })
  h.render()
  h.requests.find(r => r.path === '/tasks').resolve({ tasks: [
    { board: 'default', id: 't_a', title: 'A', hint: { optimistic: 1, most_likely: 2, pessimistic: 3 } },
  ] })
  await tick(); h.render()
  h.requests.find(r => r.path.startsWith('/forecast')).resolve({ ok: true, hint: { most_likely: 2 }, percentiles_days: { p50: 0.25 }, iterations: 5000 })
  await tick(); h.render()

  h.nodes().find(n => n.type === 'button' && n.props.children === 'Refresh').props.onClick()
  h.render()
  const refreshTasks = h.requests.filter(r => r.path === '/tasks').at(-1)
  refreshTasks.resolve({ tasks: [
    { board: 'default', id: 't_a', title: 'A', hint: { optimistic: 40, most_likely: 80, pessimistic: 100 } },
  ] })
  await tick(); h.render()

  const forecasts = h.requests.filter(r => r.path.startsWith('/forecast'))
  assert.equal(forecasts.length, 3)
  forecasts.at(-1).resolve({ ok: true, hint: { optimistic: 40, most_likely: 80, pessimistic: 100 }, percentiles_days: { p50: 10 }, iterations: 5000 })
  await tick(); h.render()
  assert.ok(h.nodes().some(n => n.props?.className === 'ep-lead'))
  assert.ok(h.nodes().some(n => typeof n.props?.children === 'string' && n.props.children.includes('40/80/100h')))
  h.unmount(); h.dispose()
})

test('malformed events cannot navigate or refresh', async () => {
  const h = await harness()
  h.render()
  const count = h.requests.length
  for (const payload of [null, [], {}, { view: 'other' }, { view: 'bars', item_id: 'x'.repeat(81) },
    { view: 'bars', item_id: '/home/private' }, { view: 'bars', item_id: 't_a\n' },
    { view: 'dots', text: 'private' }]) h.emit('view.set', payload)
  h.emit('data.updated', { text: 'private' })
  assert.deepEqual(h.navigated, [])
  assert.equal(h.requests.length, count)
  h.unmount(); h.dispose()
})

test('older Desktop without events still renders', async () => {
  const h = await harness({ events: false })
  h.render()
  assert.ok(h.requests.some(r => r.path === '/tasks'))
  h.unmount(); h.dispose()
})

test('missing and ambiguous card ids do not silently focus another card', async () => {
  const h = await harness()
  h.emit('view.set', { view: 'bars', item_id: 'missing' })
  h.render()
  h.requests.find(r => r.path === '/tasks').resolve({ tasks: [{ board: 'default', id: 't_a', title: 'A', hint: {} }] })
  await tick(); h.render()
  assert.ok(h.nodes().some(n => n.props?.children === 'Requested card is not open or was not found.'))
  h.emit('view.set', { view: 'bars', item_id: 't_a' })
  h.requests.filter(r => r.path === '/tasks').at(-1).resolve({ tasks: [
    { board: 'alpha', id: 't_a', title: 'A', hint: {} }, { board: 'beta', id: 't_a', title: 'B', hint: {} },
  ] })
  await tick(); h.render()
  assert.ok(h.nodes().some(n => n.props?.children === 'Card id matches multiple boards; choose a card.'))
  assert.ok(!h.requests.some(r => r.path.startsWith('/forecast')))
  h.nodes().find(n => n.type === 'select').props.onChange({ target: { value: 'beta\u0000t_a' } })
  h.render()
  assert.ok(h.requests.some(r => r.path.includes('board=beta&task_id=t_a')))
  h.unmount(); h.dispose()
})

test('a handled show request does not override later manual choices on remount', async () => {
  const h = await harness({ badges: false })
  const tasks = [{ board: 'default', id: 't_a', title: 'A', hint: {} },
    { board: 'default', id: 't_b', title: 'B', hint: {} }]
  h.emit('view.set', { view: 'dots', item_id: 't_b' })
  h.render()
  h.requests.find(r => r.path === '/tasks').resolve({ tasks })
  await tick(); h.render()
  h.nodes().find(n => n.type === 'select').props.onChange({ target: { value: 'default\u0000t_a' } })
  h.nodes().find(n => n.type?.name === 'Settings').props.s.set({ view: 'bars' })
  h.unmount(); h.remount()
  h.requests.filter(r => r.path === '/tasks').at(-1).resolve({ tasks })
  await tick(); h.render()
  assert.equal(h.saved.get('chart').view, 'bars')
  assert.equal(h.nodes().find(n => n.type === 'select').props.value, 'default\u0000t_a')
  h.unmount(); h.dispose()
})
