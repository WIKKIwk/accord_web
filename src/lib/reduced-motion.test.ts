/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'
import { transform, type Rule } from 'lightningcss'
import { beforeAll, describe, expect, it } from 'vitest'

const slots = ['dialog-overlay', 'dialog-content', 'sheet-overlay', 'sheet-content', 'dropdown-menu-content', 'dropdown-menu-sub-content', 'select-content', 'tooltip-content', 'skeleton']
type MotionMedia = Extract<Rule, { type: 'media' }>
const motionRules: MotionMedia[] = []
let compiled = '', withoutGuard = ''
const isUiMotionGuard = (rule: Rule): rule is MotionMedia => rule.type === 'media' && rule.value.rules.some(child => child.type === 'style' && child.value.selectors.some(selector => selector.some(part => part.type === 'attribute' && part.name === 'data-slot' && part.operation?.value === 'dialog-content')))

beforeAll(async () => {
  const path = new URL('../index.css', import.meta.url), source = readFileSync(path, 'utf8')
  const options = { base: fileURLToPath(new URL('.', path)), onDependency: () => {} }
  const candidates = ['data-open:animate-in', 'data-closed:animate-out', 'data-open:fade-in-0', 'data-closed:fade-out-0', 'data-open:zoom-in-95', 'data-closed:zoom-out-95', 'data-[side=right]:data-open:slide-in-from-right-10', 'duration-100', 'duration-200', 'animate-spin', 'animate-pulse', 'shimmer', 'hidden', '-translate-x-1/2', '-translate-y-1/2', 'focus-visible:ring-3']
  compiled = (await compile(source, options)).build(candidates)
  withoutGuard = (await compile(source.slice(0, source.lastIndexOf('@media (prefers-reduced-motion: reduce)')), options)).build(candidates)
  transform({ filename: 'app.css', code: Buffer.from(compiled), visitor: { Rule(rule) { if (isUiMotionGuard(rule)) motionRules.push(rule) } } })
})

describe('compiled first-party reduced-motion safeguard', () => {
  it('runs only for the reduce preference and targets native panels/loaders, never the CAD scene or every element', () => {
    expect(motionRules).toHaveLength(1)
    const media = motionRules[0]
    expect(media.value.query.mediaQueries).toEqual([{ qualifier: null, mediaType: 'all', condition: { type: 'feature', value: { type: 'plain', name: 'prefers-reduced-motion', value: { type: 'ident', value: 'reduce' } } } }])
    expect(media.value.rules).toHaveLength(1)
    const style = media.value.rules[0]
    expect(style.type).toBe('style')
    if (style.type !== 'style') throw new Error('Reduced-motion style is missing')
    expect(style.value.selectors).toHaveLength(slots.length + 3)
    expect(style.value.selectors.every(selector => selector.length === 1)).toBe(true)
    expect(style.value.selectors.map(selector => selector[0]).filter(part => part.type === 'attribute').map(part => part.type === 'attribute' ? part.operation?.value : '')).toEqual(slots)
    expect(style.value.selectors.map(selector => selector[0]).filter(part => part.type === 'class').map(part => part.type === 'class' ? part.name : '')).toEqual(['animate-spin', 'animate-pulse', 'shimmer'])
  })

  it('wins over enter/exit and repeated loading animations without overriding visibility, positions, pointer input, focus, text or colors', () => {
    const style = motionRules[0].value.rules[0]
    if (style.type !== 'style') throw new Error('Reduced-motion style is missing')
    const declarations = style.value.declarations
    expect(declarations?.declarations).toEqual([])
    expect(declarations?.importantDeclarations?.map(declaration => declaration.property)).toEqual(['animation', 'transition'])
    const animation = declarations?.importantDeclarations?.find(declaration => declaration.property === 'animation')
    const transition = declarations?.importantDeclarations?.find(declaration => declaration.property === 'transition')
    if (animation?.property !== 'animation' || transition?.property !== 'transition') throw new Error('Motion overrides are missing')
    expect(animation.value).toHaveLength(1)
    expect(animation.value[0]).toMatchObject({ name: { type: 'none' }, duration: { value: 0 }, delay: { value: 0 } })
    expect(transition.value).toHaveLength(1)
    expect(transition.value[0]).toMatchObject({ property: { property: 'none' }, duration: { value: 0 }, delay: { value: 0 } })
  })

  it('preserves the entire default stylesheet, including Radix state motion, placement and focus rules outside the preference', () => {
    const normalize = (css: string, removeGuard = false) => transform({ filename: 'app.css', code: Buffer.from(css), visitor: { Rule(rule) { if (removeGuard && isUiMotionGuard(rule)) return [] } } }).code.toString()
    expect(normalize(compiled, true)).toBe(normalize(withoutGuard))
    expect(withoutGuard).toContain('@keyframes enter')
    expect(withoutGuard).toContain('@keyframes exit')
    expect(withoutGuard).toContain('@keyframes spin')
    expect(withoutGuard).toContain('@keyframes pulse')
  })
})
