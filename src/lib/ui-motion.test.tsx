/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Children, createElement, isValidElement, useEffect } from 'react'
import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { compile } from '@tailwindcss/node'
import { transform } from 'lightningcss'
import type { Declaration, Rule } from 'lightningcss'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DialogContent, DialogOverlay } from '@/components/ui/dialog'
import { SheetContent } from '@/components/ui/sheet'
import { DropdownMenuContent, DropdownMenuSubContent } from '@/components/ui/dropdown-menu'
import { SelectContent } from '@/components/ui/select'
import { TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { Sidebar, SidebarGroupLabel, SidebarMenuButton, SidebarProvider, SidebarRail, SidebarTrigger } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { listEntranceClass, uiOverlayMotion, uiSurfaceMotion } from './ui-motion'

type Props = Record<string, unknown> & { children?: ReactNode; className?: string }
const primitives = vi.hoisted(() => new Map<string, Props>())
type ButtonProps = ComponentProps<typeof import('@/components/ui/button').Button>
const buttons = vi.hoisted(() => [] as ButtonProps[])
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useEffect: vi.fn(actual.useEffect) }
})
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: vi.fn(() => false) }))
vi.mock('@/components/ui/button', async original => {
  const actual = await original<typeof import('@/components/ui/button')>()
  return { ...actual, Button: (props: ButtonProps) => { buttons.push(props); return <actual.Button {...props} /> } }
})
// Observe forwarded Radix props; browser focus/presence timing is verified by the parent task.
vi.mock('radix-ui', async () => {
  const { createElement } = await import('react')
  const primitive = (props: Props) => {
    if (typeof props['data-slot'] === 'string') primitives.set(props['data-slot'], props)
    return createElement('div', { 'data-slot': props['data-slot'], className: props.className }, props.children)
  }
  const namespace = Object.fromEntries(['Root', 'Trigger', 'Portal', 'Overlay', 'Content', 'Close', 'Title', 'Description', 'Group', 'Item', 'CheckboxItem', 'RadioGroup', 'RadioItem', 'Label', 'Separator', 'Sub', 'SubTrigger', 'SubContent', 'ItemIndicator', 'Value', 'Icon', 'Viewport', 'ItemText', 'ScrollUpButton', 'ScrollDownButton', 'Provider', 'Arrow'].map(name => [name, primitive]))
  return { Dialog: namespace, DropdownMenu: namespace, Select: namespace, Tooltip: namespace, Slot: namespace }
})

type Style = Extract<Rule, { type: 'style' }>
type Keyframes = Extract<Rule, { type: 'keyframes' }>
type Media = Extract<Rule, { type: 'media' }>
const styles: Style[] = [], frames: Keyframes[] = [], media: Media[] = []
const render = (node: ReactNode) => renderToStaticMarkup(node)
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
let css = ''
function property(declaration: Declaration): string { return declaration.property === 'unparsed' ? declaration.value.propertyId.property : declaration.property }
function styleForClass(name: string): Style {
  const found = styles.find(rule => rule.value.selectors.some(selector => selector.some(part => part.type === 'class' && part.name === name)))
  if (!found) throw new Error(`Missing compiled class: ${name}`)
  return found
}
function classOf(slot: string): string {
  const value = primitives.get(slot)?.className; if (!value) throw new Error(`Missing Radix surface: ${slot}`); return value
}

beforeAll(async () => {
  render(createElement(DialogContent)); render(createElement(DialogOverlay)); render(createElement(SheetContent))
  render(createElement(DropdownMenuContent)); render(createElement(DropdownMenuSubContent)); render(createElement(SelectContent, { position: 'popper' }))
  render(createElement(TooltipContent)); render(createElement(Skeleton))
  const candidates = [...primitives.values()].flatMap(props => props.className?.split(/\s+/) ?? [])
  candidates.push(...uiSurfaceMotion.split(' '), ...uiOverlayMotion.split(' '), 'motion-safe:animate-pulse', 'motion-reduce:animate-none', 'transition-opacity', 'transition-transform', 'transition-none', listEntranceClass)
  const path = new URL('../index.css', import.meta.url)
  css = (await compile(readFileSync(path, 'utf8'), { base: fileURLToPath(new URL('.', path)), onDependency: () => {} })).build(candidates)
  transform({ filename: 'motion.css', code: Buffer.from(css), visitor: { Rule(rule) {
    if (rule.type === 'style') styles.push(rule)
    if (rule.type === 'keyframes') frames.push(rule)
    if (rule.type === 'media') media.push(rule)
  } } })
  primitives.clear()
})
afterEach(() => {
  primitives.clear(); buttons.length = 0; vi.clearAllMocks(); vi.unstubAllGlobals()
  vi.mocked(useIsMobile).mockReturnValue(false)
})

describe('compiled bounded UI motion', () => {
  it('uses only opacity and transform in its surface/list keyframes, and opacity only in fades/loaders', () => {
    const own = frames.filter(rule => String(rule.value.name.value).startsWith('accord-'))
    expect(own.map(rule => String(rule.value.name.value)).sort()).toEqual(['accord-list-enter', 'accord-ui-enter', 'accord-ui-exit', 'accord-ui-fade-in', 'accord-ui-fade-out'])
    for (const rule of own) {
      const properties = rule.value.keyframes.flatMap(frame => (frame.declarations.declarations ?? []).map(property))
      expect(properties.length).toBeGreaterThan(0)
      expect(properties.every(name => ['opacity', 'transform'].includes(name))).toBe(true)
      if (String(rule.value.name.value).includes('fade')) expect(new Set(properties)).toEqual(new Set(['opacity']))
    }
    const pulse = frames.find(rule => String(rule.value.name.value) === 'pulse')
    expect(pulse).toBeDefined()
    expect(pulse!.value.keyframes.flatMap(frame => (frame.declarations.declarations ?? []).map(property))).toEqual(['opacity'])
  })
  it('keeps enters/exits short with explicit animation easing and no implicit geometry transitions', () => {
    for (const [name, expected] of [['duration-150', 150], ['data-closed:duration-100', 100]] as const) {
      const duration = styleForClass(name).value.declarations?.declarations?.find(declaration => declaration.property === 'transition-duration')
      if (duration?.property !== 'transition-duration') throw new Error(`Missing duration: ${name}`)
      expect(duration.value.map(time => time.type === 'seconds' ? time.value * 1000 : time.value)).toEqual([expected])
    }
    for (const [name, easing] of [['data-open:animate-ui-enter', 'ease-out'], ['data-closed:animate-ui-exit', 'ease-in'], ['data-open:animate-ui-fade-in', 'ease-out'], ['data-closed:animate-ui-fade-out', 'ease-in']] as const) {
      const animation = styleForClass(name).value.declarations?.declarations?.find(declaration => property(declaration) === 'animation')
      expect(animation).toBeDefined(); expect(JSON.stringify(animation)).toContain(easing)
      expect(JSON.stringify(animation)).not.toContain('--tw-ease')
    }
    const transition = styleForClass('transition-none').value.declarations?.declarations?.find(declaration => declaration.property === 'transition-property')
    if (transition?.property !== 'transition-property') throw new Error('Missing explicit transition suppression')
    expect(transition.value).toEqual([{ property: 'none' }])
    expect(uiSurfaceMotion.split(' ')).toContain('transition-none'); expect(uiOverlayMotion.split(' ')).toContain('transition-none')
    expect(uiSurfaceMotion + uiOverlayMotion).not.toMatch(/delay-|will-change|transition-all/)
    expect(read('../index.css').slice(read('../index.css').indexOf('/* Reuse tw-animate-css'))).not.toContain('will-change')
  })
  it('limits list entrance to one opt-in class under no-preference with one iteration and zero delay', () => {
    expect(listEntranceClass).toBe('motion-list-enter')
    const listMedia = media.find(rule => rule.value.rules.some(child => child.type === 'style' && child.value.selectors.some(selector => selector.some(part => part.type === 'class' && part.name === listEntranceClass))))
    expect(listMedia).toBeDefined()
    expect(listMedia!.value.query.mediaQueries).toEqual([{ qualifier: null, mediaType: 'all', condition: { type: 'feature', value: { type: 'plain', name: 'prefers-reduced-motion', value: { type: 'ident', value: 'no-preference' } } } }])
    expect(listMedia!.value.rules).toHaveLength(1)
    const list = listMedia!.value.rules[0]
    if (list.type !== 'style') throw new Error('Missing list entrance style')
    expect(list.value.selectors).toEqual([[{ type: 'class', name: listEntranceClass }]])
    expect(list.value.declarations?.declarations?.map(property)).toEqual(['animation'])
    const animation = list.value.declarations?.declarations?.[0]
    if (animation?.property !== 'animation') throw new Error('Missing list animation')
    expect(animation.value).toHaveLength(1)
    expect(animation.value[0]).toMatchObject({ name: { type: 'ident', value: 'accord-list-enter' }, duration: { value: 160 }, delay: { value: 0 }, iterationCount: { type: 'number', value: 1 }, fillMode: 'none' })
  })
  it('keeps scoped reduced-motion suppression and immediate sidebar geometry changes', () => {
    expect(styleForClass('motion-reduce:animate-none').value.declarations?.declarations?.some(declaration => property(declaration) === 'animation')).toBe(true)
    expect(styleForClass('motion-reduce:transition-none').value.declarations?.declarations?.some(declaration => property(declaration) === 'transition-property')).toBe(true)
    const sidebar = read('../components/ui/sidebar.tsx')
    expect(sidebar).not.toMatch(/transition-\[(?:width|left|margin)|transition-all|transition-\[width,height,padding\]/)
    expect(sidebar).toContain('transition-opacity duration-150 ease-out motion-reduce:transition-none')
    const reducedGuard = read('../index.css').slice(read('../index.css').lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedGuard).toContain('animation: none !important'); expect(reducedGuard).toContain('transition: none !important')
    expect(reducedGuard).not.toMatch(/transform:|opacity:|display:|visibility:|pointer-events:/)
  })
})

describe('mobile Sidebar dismissal and opener focus', () => {
  class FocusTarget {
    isConnected = true
    focus = vi.fn()
  }
  function mobileDrawer(onClick?: ButtonProps['onClick']) {
    vi.mocked(useIsMobile).mockReturnValue(true)
    render(<SidebarProvider><SidebarTrigger onClick={onClick} /><Sidebar><SidebarMenuButton tooltip="Module tooltip">Module</SidebarMenuButton></Sidebar></SidebarProvider>)
    const trigger = buttons.find(props => (props as Props)['data-slot'] === 'sidebar-trigger')
    const closeFocus = primitives.get('sidebar')?.onCloseAutoFocus as ComponentProps<typeof SheetContent>['onCloseAutoFocus']
    if (!trigger?.onClick || !closeFocus) throw new Error('Missing mobile Sidebar handlers')
    expect(primitives.get('sidebar')).toMatchObject({ 'data-slot': 'sidebar', 'data-mobile': 'true' })
    return { click: trigger.onClick, closeFocus }
  }
  function fakeDocument(activeElement: FocusTarget) {
    vi.stubGlobal('HTMLElement', FocusTarget)
    vi.stubGlobal('document', { activeElement, cookie: '' })
  }
  it.each([
    { mobile: true, defaultOpen: false },
    { mobile: false, defaultOpen: true },
  ])('keeps stable tooltip wrappers but omits dismissable content for mobile=$mobile expanded=$defaultOpen', ({ mobile, defaultOpen }) => {
    vi.mocked(useIsMobile).mockReturnValue(mobile)
    const html = render(<SidebarProvider defaultOpen={defaultOpen}><SidebarMenuButton tooltip="Module tooltip">Module</SidebarMenuButton></SidebarProvider>)
    expect(html).toContain('data-slot="sidebar-menu-button"')
    for (const slot of ['tooltip', 'tooltip-trigger']) expect(primitives.has(slot)).toBe(true)
    expect(primitives.get('tooltip-trigger')?.asChild).toBe(true)
    expect(primitives.has('tooltip-content')).toBe(false)
  })
  it('retains collapsed desktop tooltip content, alignment and caller props', () => {
    const onEscapeKeyDown = vi.fn()
    render(<SidebarProvider defaultOpen={false}><SidebarMenuButton tooltip={{ children: 'Module tooltip', side: 'left', align: 'end', onEscapeKeyDown }}>Module</SidebarMenuButton></SidebarProvider>)
    expect(primitives.has('tooltip')).toBe(true); expect(primitives.has('tooltip-trigger')).toBe(true)
    expect(primitives.get('tooltip-content')).toMatchObject({ side: 'left', align: 'end', onEscapeKeyDown })
    expect(primitives.get('tooltip-content')?.children).toEqual(expect.arrayContaining(['Module tooltip']))
    expect(primitives.get('tooltip-content')?.hidden).toBeUndefined()
  })
  it('keeps navigation trigger ancestry, element type and caller handlers stable through desktop expand/collapse', () => {
    const onClick = vi.fn(), onContextMenu = vi.fn()
    const buttonTypes: unknown[] = []
    for (const open of [true, false, true]) {
      primitives.clear()
      render(<SidebarProvider open={open}><SidebarMenuButton asChild tooltip="Orders" onClick={onClick} onContextMenu={onContextMenu}><a href="/orders">Orders</a></SidebarMenuButton></SidebarProvider>)
      const trigger = Children.toArray(primitives.get('tooltip')?.children)[0]
      if (!isValidElement<{ asChild: boolean; children: ReactNode }>(trigger)) throw new Error('Missing stable Tooltip trigger')
      expect(trigger.type).toBe(TooltipTrigger); expect(trigger.key).toBe('.0'); expect(trigger.props.asChild).toBe(true)
      const button = Children.only(trigger.props.children)
      if (!isValidElement<Props>(button)) throw new Error('Missing stable navigation button')
      buttonTypes.push(button.type)
      expect(button.props).toMatchObject({ 'data-slot': 'sidebar-menu-button', onClick, onContextMenu })
      const link = Children.only(button.props.children)
      if (!isValidElement<{ href: string }>(link)) throw new Error('Missing navigation link')
      expect(link.type).toBe('a'); expect(link.props.href).toBe('/orders')
      expect(primitives.has('tooltip-content')).toBe(!open)
    }
    expect(buttonTypes.every(type => type === buttonTypes[0])).toBe(true)
    expect(onClick).not.toHaveBeenCalled(); expect(onContextMenu).not.toHaveBeenCalled()
  })
  it('restores the connected clicked opener once and preserves its supplied click callback', () => {
    const opener = new FocusTarget(), previouslyFocused = new FocusTarget()
    fakeDocument(previouslyFocused)
    const onClick = vi.fn<NonNullable<ButtonProps['onClick']>>(() => expect(opener.focus).not.toHaveBeenCalled())
    const { click, closeFocus } = mobileDrawer(onClick)
    const clickEvent = { currentTarget: opener } as unknown as MouseEvent<HTMLButtonElement>
    click(clickEvent); expect(onClick).toHaveBeenCalledOnce(); expect(onClick.mock.calls[0]?.[0]).toBe(clickEvent)
    const event = { preventDefault: vi.fn() } as unknown as Event
    closeFocus(event)
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(opener.focus).toHaveBeenCalledOnce()
    expect(previouslyFocused.focus).not.toHaveBeenCalled()
    const again = { preventDefault: vi.fn() } as unknown as Event
    closeFocus(again); expect(again.preventDefault).not.toHaveBeenCalled(); expect(opener.focus).toHaveBeenCalledOnce()
  })
  it('captures the active shortcut opener and removes the keyboard listener during cleanup', () => {
    const opener = new FocusTarget()
    fakeDocument(opener); vi.stubGlobal('window', new EventTarget())
    const { closeFocus } = mobileDrawer()
    const setup = vi.mocked(useEffect).mock.calls[0]?.[0]
    if (!setup) throw new Error('Missing Sidebar shortcut effect')
    const cleanup = setup()
    if (typeof cleanup !== 'function') throw new Error('Missing Sidebar shortcut cleanup')
    const shortcut = new Event('keydown', { cancelable: true })
    Object.assign(shortcut, { key: 'b', ctrlKey: true, metaKey: false })
    window.dispatchEvent(shortcut); expect(shortcut.defaultPrevented).toBe(true)
    const event = { preventDefault: vi.fn() } as unknown as Event
    closeFocus(event); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(opener.focus).toHaveBeenCalledOnce()
    cleanup()
    const afterCleanup = new Event('keydown', { cancelable: true })
    Object.assign(afterCleanup, { key: 'b', ctrlKey: true, metaKey: false })
    window.dispatchEvent(afterCleanup); expect(afterCleanup.defaultPrevented).toBe(false)
  })
  it('leaves Radix fallback focus intact if the opener disconnects before close', () => {
    const opener = new FocusTarget()
    fakeDocument(opener)
    const { click, closeFocus } = mobileDrawer()
    click({ currentTarget: opener } as unknown as MouseEvent<HTMLButtonElement>); opener.isConnected = false
    const event = { preventDefault: vi.fn() } as unknown as Event
    closeFocus(event); expect(event.preventDefault).not.toHaveBeenCalled(); expect(opener.focus).not.toHaveBeenCalled()
  })
})

describe('Radix presence, alignment and caller interaction props remain owned by primitives', () => {
  it('forwards modal presence and focus/escape/outside callbacks without adding handlers or delays', () => {
    const onEscapeKeyDown = vi.fn(), onCloseAutoFocus = vi.fn(), onPointerDownOutside = vi.fn()
    for (const [component, slot] of [[DialogContent, 'dialog-content'], [SheetContent, 'sheet-content'], [DropdownMenuContent, 'dropdown-menu-content'], [DropdownMenuSubContent, 'dropdown-menu-sub-content']] as const) {
      render(createElement(component, { forceMount: true, onEscapeKeyDown, onCloseAutoFocus, onPointerDownOutside }))
      const props = primitives.get(slot)
      expect(props).toMatchObject({ forceMount: true, onEscapeKeyDown, onCloseAutoFocus, onPointerDownOutside })
      expect(props?.className).toContain('data-open:animate-ui-enter'); expect(props?.className).toContain('data-closed:animate-ui-exit')
      expect(props?.className).toContain('motion-reduce:animate-none'); expect(props?.className).not.toMatch(/transition-all|will-change|delay-/)
      expect(props?.className?.split(' ')).toContain('transition-none')
    }
    expect(onEscapeKeyDown).not.toHaveBeenCalled(); expect(onCloseAutoFocus).not.toHaveBeenCalled(); expect(onPointerDownOutside).not.toHaveBeenCalled()
  })
  it('uses opacity-only overlays and keeps centered dialog placement plus caller size overrides', () => {
    render(createElement(DialogOverlay, { forceMount: true })); expect(classOf('dialog-overlay')).toContain('animate-ui-fade-in'); expect(classOf('dialog-overlay')).not.toContain('zoom-')
    render(createElement(DialogContent, { className: 'sm:max-w-2xl', showCloseButton: false }))
    const classes = classOf('dialog-content')
    for (const value of ['-translate-x-1/2', '-translate-y-1/2', 'sm:max-w-2xl', 'bg-popover', 'text-popover-foreground', 'zoom-in-98']) expect(classes).toContain(value)
    expect(primitives.get('dialog-content')?.showCloseButton).toBeUndefined()
  })
  it.each(['top', 'right', 'bottom', 'left'] as const)('keeps sheet side %s while shortening its offset', side => {
    render(createElement(SheetContent, { side }))
    expect(primitives.get('sheet-content')?.['data-side']).toBe(side)
    expect(classOf('sheet-content')).toContain(`data-[side=${side}]:data-open:slide-in-from-${side}-4`)
    expect(classOf('sheet-content')).not.toMatch(/slide-in-from-(?:top|right|bottom|left)-10|(?:^|\s)transition(?:\s|$)/)
  })
  it('preserves item-aligned select suppression and popper collision/viewport positioning', () => {
    const onEscapeKeyDown = vi.fn()
    render(createElement(SelectContent, { onEscapeKeyDown }))
    expect(primitives.get('select-content')).toMatchObject({ position: 'item-aligned', 'data-align-trigger': true, onEscapeKeyDown })
    expect(classOf('select-content')).toContain('data-[align-trigger=true]:animate-none')
    render(createElement(SelectContent, { position: 'popper', align: 'end', onEscapeKeyDown }))
    expect(primitives.get('select-content')).toMatchObject({ position: 'popper', align: 'end', 'data-align-trigger': false, onEscapeKeyDown })
    expect(classOf('select-content')).toContain('origin-(--radix-select-content-transform-origin)')
    expect(classOf('select-content')).toContain('data-[side=bottom]:translate-y-1')
  })
  it('animates instant and delayed tooltip states while honoring the existing provider delay', () => {
    render(<TooltipProvider>{null}</TooltipProvider>); expect(primitives.get('tooltip-provider')?.delayDuration).toBe(0)
    render(<TooltipProvider delayDuration={320}>{null}</TooltipProvider>); expect(primitives.get('tooltip-provider')?.delayDuration).toBe(320)
    render(createElement(TooltipContent))
    const classes = classOf('tooltip-content')
    expect(classes).toContain('data-[state=instant-open]:animate-ui-enter'); expect(classes).toContain('data-[state=delayed-open]:animate-ui-enter')
    expect(classes).toContain('origin-(--radix-tooltip-content-transform-origin)'); expect(classes).not.toContain('delay-')
    expect(css).toContain('instant-open'); expect(css).toContain('delayed-open')
  })
  it('keeps skeleton pulse motion-safe and sidebar state/layout/palette attributes intact', () => {
    const skeleton = render(createElement(Skeleton, { className: 'h-20 w-20' }))
    expect(skeleton).toContain('motion-safe:animate-pulse'); expect(skeleton).toContain('motion-reduce:animate-none'); expect(skeleton).toContain('bg-muted')
    const sidebar = render(createElement(SidebarProvider, { defaultOpen: false }, createElement(Sidebar, { collapsible: 'icon' }, createElement(SidebarGroupLabel, null, 'QA Group'), createElement(SidebarMenuButton, null, 'QA Entry'), createElement(SidebarRail))))
    expect(sidebar).toContain('data-state="collapsed"'); expect(sidebar).toContain('data-collapsible="icon"')
    expect(sidebar).toContain('data-slot="sidebar-gap"'); expect(sidebar).toContain('data-slot="sidebar-container"'); expect(sidebar).toContain('bg-sidebar')
    expect(sidebar).not.toMatch(/transition-\[width|transition-all|transition-\[left/)
    expect(sidebar).toContain('transition-opacity'); expect(sidebar).toContain('transition-transform')
  })
})
