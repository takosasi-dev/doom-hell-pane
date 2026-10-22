// 絵とキーの変換。エンジン (hellpane-engine.exe) とのやりとりの形はここだけで決める
//
// 絵: エンジンは標準出力に 1 行ずつ "HPF <w> <h> <w*h の RGB を base64>" を書く
// キー: プラグインがファイルを丸ごと書き直す
//   HP1 <w> <h> <quit>
//   <seq> <doomkey>   (押された 1 回ごとに 1 行。キーの連打もそのまま)
//   END

export type Frame = { w: number; h: number; rgb: Uint8Array }

// 実行環境にある base64 の関数 (TypeScript の es2023 の型にはまだ無いので、ここで型を付ける)
export const toBase64 = (bytes: Uint8Array): string => (bytes as unknown as { toBase64(): string }).toBase64()
export const fromBase64 = (text: string): Uint8Array => (Uint8Array as unknown as { fromBase64(t: string): Uint8Array }).fromBase64(text)

export type KeyPress = { seq: number; key: number }

/** DOOM のキー番号 (doomkeys.h) */
export const DK = {
  right: 0xae,
  left: 0xac,
  up: 0xad,
  down: 0xaf,
  strafeL: 0xa0,
  strafeR: 0xa1,
  use: 0xa2,
  fire: 0xa3,
  escape: 27,
  enter: 13,
  tab: 9,
  shift: 0x80 + 0x36,
} as const

/** キーファイルに残す押下の数。エンジンは 15ms ごとに読むので、これで足りる */
export const KEEP_PRESSES = 48

/** 入力欄に打った 1 文字を DOOM のキーに変える。大文字は走りながら (shift も押す) */
export const keysForChar = (ch: string): number[] => {
  const lower = ch.toLowerCase()
  const run = ch !== lower ? [DK.shift] : []
  const map: Record<string, number> = {
    w: DK.up,
    s: DK.down,
    a: DK.left,
    d: DK.right,
    q: DK.strafeL,
    e: DK.strafeR,
    j: DK.fire,
    f: DK.fire,
    k: DK.use,
    ' ': DK.use,
    m: DK.escape,
    v: DK.tab,
    y: 'y'.charCodeAt(0),
    n: 'n'.charCodeAt(0),
  }
  if (lower in map) return [...run, map[lower]!]
  if (/^[1-7]$/.test(ch)) return [ch.charCodeAt(0)]
  return []
}

/**
 * 入力欄の前の文字と今の文字から、新しく打たれた文字を取り出す。
 * 後ろに足されたならその分、置き換わったなら最後の 1 文字
 */
export const typedSince = (before: string, now: string): string => {
  if (now.length > before.length && now.startsWith(before)) return now.slice(before.length)
  if (now.length === 0) return ''
  return now !== before ? now.slice(-1) : ''
}

/** 入力欄に描く値。打たれたとおりにし、FIELD_MAX 字を超えたら空に戻す */
export const FIELD_MAX = 32
export const fieldValue = (typed: string): string => (typed.length > FIELD_MAX ? '' : typed)

export const keyFileText = (w: number, h: number, presses: readonly KeyPress[], quit = false): string =>
  [`HP1 ${w} ${h} ${quit ? 1 : 0}`, ...presses.map(p => `${p.seq} ${p.key}`), 'END', ''].join('\n')

/** 1 行が絵ならほどいて返す。違えば (エンジンのふつうの出力なら) null */
export const parseFrameLine = (line: string): Frame | null => {
  if (!line.startsWith('HPF ')) return null
  const m = /^HPF (\d+) (\d+) ([A-Za-z0-9+/=]+)\s*$/.exec(line)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  let rgb: Uint8Array
  try {
    rgb = fromBase64(m[3]!)
  } catch {
    return null
  }
  if (w <= 0 || h <= 0 || rgb.length !== w * h * 3) return null
  return { w, h, rgb }
}

/**
 * 流れてきた文字を行に切る。最後の 1 枚の絵だけを返し (古い絵は飛ばす)、
 * 行の途中で切れた残りを rest で返す
 */
export const takeLatestFrame = (buffer: string): { frame: Frame | null; rest: string } => {
  const cut = buffer.lastIndexOf('\n')
  if (cut < 0) return { frame: null, rest: buffer }
  const lines = buffer.slice(0, cut).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const f = parseFrameLine(lines[i]!)
    if (f) return { frame: f, rest: buffer.slice(cut + 1) }
  }
  return { frame: null, rest: buffer.slice(cut + 1) }
}

/** terminal 用: 縦 2 ドットを 1 マス (▀ の上が文字色、下が背景色) にした Raster の cells */
export const rasterCells = (f: Frame): { columns: number; rows: number; cells: string } => {
  const rows = Math.floor(f.h / 2)
  const words = new Uint32Array(f.w * rows * 3)
  let o = 0
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < f.w; x++) {
      const t = ((r * 2) * f.w + x) * 3
      const b = ((r * 2 + 1) * f.w + x) * 3
      words[o++] = 0x2580
      words[o++] = (f.rgb[t]! << 16) | (f.rgb[t + 1]! << 8) | f.rgb[t + 2]!
      words[o++] = (f.rgb[b]! << 16) | (f.rgb[b + 1]! << 8) | f.rgb[b + 2]!
    }
  }
  return { columns: f.w, rows, cells: toBase64(new Uint8Array(words.buffer)) }
}

/** vscode 用: 24bit の BMP (下の行から、BGR) */
export const bmpBytes = (f: Frame): Uint8Array => {
  const stride = Math.ceil((f.w * 3) / 4) * 4
  const size = 54 + stride * f.h
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  out[0] = 0x42
  out[1] = 0x4d
  v.setUint32(2, size, true)
  v.setUint32(10, 54, true)
  v.setUint32(14, 40, true)
  v.setInt32(18, f.w, true)
  v.setInt32(22, f.h, true)
  v.setUint16(26, 1, true)
  v.setUint16(28, 24, true)
  v.setUint32(34, stride * f.h, true)
  for (let y = 0; y < f.h; y++) {
    const row = 54 + (f.h - 1 - y) * stride
    for (let x = 0; x < f.w; x++) {
      const s = (y * f.w + x) * 3
      out[row + x * 3] = f.rgb[s + 2]!
      out[row + x * 3 + 1] = f.rgb[s + 1]!
      out[row + x * 3 + 2] = f.rgb[s]!
    }
  }
  return out
}

/** vscode 用: 絵を 1 枚埋め込んだ SVG。幅いっぱいに伸びる (width と height は付けない) */
export const frameSvg = (f: Frame): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} ${f.h}">` +
  `<image width="${f.w}" height="${f.h}" image-rendering="pixelated" preserveAspectRatio="none" ` +
  `href="data:image/bmp;base64,${toBase64(bmpBytes(f))}"/></svg>`

/** Svg の source の上限 (131,072 字) に収まる、vscode 用の絵の大きさ */
export const SVG_FRAME = { w: 160, h: 120 } as const

/**
 * terminal 用の絵の大きさ。ペインの幅に合わせ、元の画面の縦横比 (4:3 に引き伸ばして見る) を保つ。
 * h は 2 の倍数 (1 マスに縦 2 ドット)
 */
export const terminalFrameSize = (bodyColumns: number): { w: number; h: number } => {
  const w = Math.max(32, Math.min(200, Math.floor(bodyColumns)))
  const h = Math.max(10, Math.round((w * 0.75) / 2) * 2)
  return { w, h }
}
