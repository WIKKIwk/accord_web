import qrcode from 'qrcode-generator'

export interface PaddonQrSymbol {
  readonly code: string
  readonly modules: readonly (readonly boolean[])[]
  readonly size: number
  readonly quietZone: 4
  readonly path: string
}

/** QR Model2, numeric payload and H correction; the code is never converted to a number. */
export function paddonQrSymbol(code: string): PaddonQrSymbol {
  if (typeof code !== 'string' || code.length !== 5 || !/^\d{5}$/.test(code)) throw new Error('Yorliq uchun besh xonali paddon kodi talab qilinadi.')
  const qr = qrcode(0, 'H')
  qr.addData(code, 'Numeric'); qr.make()
  const modules = Array.from({ length: qr.getModuleCount() }, (_, y) => Object.freeze(Array.from({ length: qr.getModuleCount() }, (_, x) => qr.isDark(y, x))))
  const quietZone = 4
  const path = modules.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + quietZone},${y + quietZone}h1v1h-1z`] : [])).join('')
  return Object.freeze({ code, modules: Object.freeze(modules), size: qr.getModuleCount() + quietZone * 2, quietZone, path })
}

export function paddonQrSvg(symbol: PaddonQrSymbol): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${symbol.size} ${symbol.size}" role="img" aria-label="Paddon ${symbol.code} QR" shape-rendering="crispEdges"><rect width="${symbol.size}" height="${symbol.size}" fill="white"/><path d="${symbol.path}" fill="black"/></svg>`
}

/** Standalone local document. It contains no endpoint, token, driver or confirmation call. */
export function paddonLabelDocument(code: string): string {
  const svg = paddonQrSvg(paddonQrSymbol(code))
  return `<!doctype html>
<html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paddon ${code} · Yorliq</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f4f4;color:#000;font:16px/1.5 Arial,sans-serif}.tools{max-width:720px;margin:24px auto;padding:0 20px}.tools h1{font-size:20px;margin:0 0 12px}.tools p{font-size:14px;color:#444}.tools button{padding:10px 14px;border:1px solid #222;border-radius:8px;background:#fff;cursor:pointer;font:inherit}.label{width:100mm;height:100mm;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:5mm;margin:20px auto;border:1px solid #ddd;break-inside:avoid}.label svg{width:72mm;height:72mm;flex:none}.label p{margin:1mm 0 0;font-size:8mm;font-weight:700;line-height:1.2}
@media screen and (max-width:430px){.label{width:90vw;height:90vw;padding:4vw}.label svg{width:65vw;height:65vw}.label p{font-size:7vw}}
@page{size:100mm 100mm;margin:0}@media print{html,body{width:100mm;margin:0;background:#fff}.tools{display:none}.label{margin:0;border:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><div class="tools"><h1>Paddon ${code} yorlig‘i</h1><button id="print" type="button">Brauzer bosma oynasini ochish</button><p id="status" role="status">Qog‘ozga bosilganini brauzer tasdiqlamaydi. Paddonning serverdagi bosish qulfi o‘zgarmaydi.</p><p>100 × 100 mm yorliq. Bosma oynasida qog‘oz o‘lchami va masshtabni tekshiring; nusxa sonini shu yerda tanlang.</p></div><main class="label" aria-label="Paddon yorlig‘i">${svg}<p>${code}</p></main>
<script>
const status=document.getElementById('status');
document.getElementById('print').addEventListener('click',()=>{status.textContent='Bosma oynasi so‘raldi. Fizik natija tasdiqlanmagan; serverdagi qulf o‘zgarmaydi.';try{window.print()}catch{status.textContent='Brauzer bosma oynasini ochib bo‘lmadi. Fizik natija tasdiqlanmagan.'}});
window.addEventListener('afterprint',()=>{status.textContent='Bosma oynasi yopildi. Qog‘oz natijasini tekshiring; serverdagi qulf o‘zgarmaydi.'});
</script></body></html>`
}

export function downloadPaddonLabel(code: string): void {
  const url = URL.createObjectURL(new Blob([paddonLabelDocument(code)], { type: 'text/html;charset=utf-8' })), link = document.createElement('a')
  link.href = url; link.download = `paddon-${code}-yorliq.html`; document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function openPaddonLabel(code: string): boolean {
  const url = URL.createObjectURL(new Blob([paddonLabelDocument(code)], { type: 'text/html;charset=utf-8' }))
  const popup = window.open(url, '_blank')
  if (!popup) { URL.revokeObjectURL(url); return false }
  popup.opener = null
  popup.addEventListener('load', () => URL.revokeObjectURL(url), { once: true })
  return true
}
