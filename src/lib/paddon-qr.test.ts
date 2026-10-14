import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { paddonLabelDocument, paddonQrSvg, paddonQrSymbol } from './paddon-qr'

function raster(code: string, scale = 8) {
  const qr = paddonQrSymbol(code), size = qr.size * scale, rgba = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / scale) - qr.quietZone, column = Math.floor(x / scale) - qr.quietZone
    const value = qr.modules[row]?.[column] ? 0 : 255, index = (y * size + x) * 4
    rgba.set([value, value, value, 255], index)
  }
  return { rgba, size, qr }
}
describe('paddon QR rendering and browser print document', () => {
  for (const code of ['00000', '00001', '00007', '01010', '12345', '99999']) it(`independent decoder reads the exact leading-zero payload ${code}`, () => {
    const { rgba, size, qr } = raster(code)
    expect(jsQR(rgba, size, size)?.data).toBe(code)
    expect(qr.modules).toHaveLength(21); expect(qr.size).toBe(29); expect(qr.quietZone).toBe(4)
    expect(Object.isFrozen(qr.modules)).toBe(true)
  })
  it('keeps the required white quiet zone and black modules independent of application theme', () => {
    const qr = paddonQrSymbol('00001'), svg = paddonQrSvg(qr)
    expect(svg).toContain('fill="white"'); expect(svg).toContain('fill="black"'); expect(svg).toContain('viewBox="0 0 29 29"')
    expect(svg).not.toContain('currentColor'); expect(svg).not.toContain('<image'); expect(svg).not.toContain('http://127.')
  })
  it('rejects corrupted codes and HTML/script payloads before generating a document', () => {
    for (const code of ['', '1', '123456', ' 00001', '00001\n', '<script>', '0000１']) expect(() => paddonLabelDocument(code)).toThrow()
  })
  it('requires an explicit print-button click and provides no server mutation or physical-success bridge', () => {
    const html = paddonLabelDocument('00001')
    expect(html).toContain('100 × 100 mm'); expect(html).toContain('Brauzer bosma oynasini ochish')
    expect(html).toContain("addEventListener('click'"); expect(html).toContain("addEventListener('afterprint'")
    expect(html).toContain('serverdagi qulf o‘zgarmaydi')
    for (const forbidden of ['/qr/confirm', '/qr/print', 'fetch(', 'XMLHttpRequest', 'postMessage(', 'localStorage', 'sessionStorage', 'Authorization', 'driver_url', 'beforeprint']) expect(html).not.toContain(forbidden)
  })
})
