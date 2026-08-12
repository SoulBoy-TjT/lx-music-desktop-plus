import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  KeepAlive,
  createRenderer,
  defineComponent,
  h,
  nextTick,
  ref,
  shallowRef,
} from 'vue'
import { describe, expect, it } from 'vitest'

interface HostNode {
  type: string
  children: HostNode[]
  parent: HostNode | null
  text?: string
}

const createHostNode = (type: string, text?: string): HostNode => ({
  type,
  children: [],
  parent: null,
  text,
})

const insert = (child: HostNode, parent: HostNode, anchor: HostNode | null = null) => {
  child.parent = parent
  const anchorIndex = anchor == null ? -1 : parent.children.indexOf(anchor)
  if (anchorIndex < 0) parent.children.push(child)
  else parent.children.splice(anchorIndex, 0, child)
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => {},
  insert,
  remove: child => {
    const parent = child.parent
    if (!parent) return
    const index = parent.children.indexOf(child)
    if (index >= 0) parent.children.splice(index, 1)
    child.parent = null
  },
  createElement: type => createHostNode(type),
  createText: text => createHostNode('text', text),
  createComment: text => createHostNode('comment', text),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.children = []
    node.text = text
  },
  parentNode: node => node.parent,
  nextSibling: node => {
    const parent = node.parent
    if (!parent) return null
    const index = parent.children.indexOf(node)
    return parent.children[index + 1] ?? null
  },
  querySelector: () => null,
  setScopeId: () => {},
  cloneNode: node => ({ ...node, children: [...node.children], parent: null }),
  insertStaticContent: (content, parent, anchor) => {
    const node = createHostNode('static', content)
    insert(node, parent, anchor)
    return [node, node]
  },
})

const routerSource = readFileSync(
  fileURLToPath(new URL('../../router.ts', import.meta.url)),
  'utf8',
)
const routeStart = routerSource.indexOf("path: '/album-collection'")
const nextRouteStart = routerSource.indexOf("path: '/tools'", routeStart)
const albumCollectionRoute = routerSource.slice(routeStart, nextRouteStart)

describe('album collection route persistence', () => {
  it('retains the fetched snapshot after leaving and returning to the page', async() => {
    expect(routeStart).toBeGreaterThanOrEqual(0)
    expect(nextRouteStart).toBeGreaterThan(routeStart)

    const shouldKeepAlive = albumCollectionRoute.includes('keepAlive: true')
    const activePage = shallowRef<'album' | 'other'>('album')
    let setupCount = 0
    let snapshot = ref('')
    const AlbumCollection = defineComponent({
      name: 'AlbumCollectionFixture',
      setup() {
        setupCount++
        snapshot = ref('')
        return () => h('span', snapshot.value)
      },
    })
    const OtherPage = defineComponent({
      name: 'OtherPageFixture',
      setup: () => () => h('span', 'other'),
    })
    const Root = defineComponent({
      setup() {
        return () => {
          const page = activePage.value == 'album'
            ? h(AlbumCollection, { key: 'AlbumCollection' })
            : h(OtherPage, { key: 'Other' })
          return shouldKeepAlive
            ? h(KeepAlive, null, { default: () => page })
            : page
        }
      },
    })

    const container = createHostNode('root')
    const app = renderer.createApp(Root)
    app.mount(container)
    snapshot.value = 'fetched snapshot'
    await nextTick()

    activePage.value = 'other'
    await nextTick()
    activePage.value = 'album'
    await nextTick()

    expect(setupCount).toBe(1)
    expect(snapshot.value).toBe('fetched snapshot')
    app.unmount()
  })
})
