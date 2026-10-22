import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  bmpBytes,
  DK,
  fieldValue,
  frameSvg,
  fromBase64,
  keyFileText,
  keysForChar,
  parseFrameLine,
  rasterCells,
  SVG_FRAME,
  takeLatestFrame,
  terminalFrameSize,
  toBase64,
  typedSince,
} from '../hooks/frame'
import type { Frame } from '../hooks/frame'

const SURFACES = ['vscode', 'terminal'] as const
const PANE = {
  plugin: 'hell-pane',
  component: 'Pane',
  requestId: 'hell-pane',
  props: {
    title: 'DOOM（HellPane）',
    isFocused: false,
    bodyColumns: 29,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** w×h の絵。左上から順に色を変える */
const makeFrame = (w: number, h: number): Frame => {
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = i & 0xff
    rgb[i * 3 + 1] = (i >> 8) & 0xff
    rgb[i * 3 + 2] = 0x40
  }
  return { w, h, rgb }
}
const lineOf = (f: Frame) => `HPF ${f.w} ${f.h} ${toBase64(f.rgb)}`

test('絵の行をほどき、壊れた行とエンジンのふつうの出力は飛ばす', () => {
  const f = makeFrame(4, 2)
  const got = parseFrameLine(lineOf(f))
  expect(got?.w).toBe(4)
  expect(got?.h).toBe(2)
  expect([...(got?.rgb ?? [])]).toEqual([...f.rgb])
  expect(parseFrameLine('Z_Init: Init zone memory')).toBeNull()
  expect(parseFrameLine('HPF 4 2 AAAA')).toBeNull()
  expect(parseFrameLine('HPF 4 2 !!!')).toBeNull()
})

test('流れてきた文字から最後の絵だけを取り、切れた残りは次に回す', () => {
  const a = makeFrame(2, 2)
  const b = makeFrame(3, 2)
  const full = `log\n${lineOf(a)}\n\n${lineOf(b)}\nHPF 2 2 AA`
  const { frame, rest } = takeLatestFrame(full)
  expect(frame?.w).toBe(3)
  expect(rest).toBe('HPF 2 2 AA')
  expect(takeLatestFrame('no newline yet')).toEqual({ frame: null, rest: 'no newline yet' })
  expect(takeLatestFrame('only log\nrest').frame).toBeNull()
})

test('terminal の cells: 1 マスに縦 2 ドット (▀ の上が文字色、下が背景色)', () => {
  const f = makeFrame(2, 4)
  const c = rasterCells(f)
  expect(c.columns).toBe(2)
  expect(c.rows).toBe(2)
  const words = new Uint32Array(fromBase64(c.cells).buffer)
  expect(words.length).toBe(2 * 2 * 3)
  // 2 マス目 (右上): 上は (1,0)、下は (1,1)
  expect(words[3]).toBe(0x2580)
  expect(words[4]).toBe((1 << 16) | 0x40)
  expect(words[5]).toBe((3 << 16) | 0x40)
})

test('vscode の絵: BMP は下の行から BGR で、SVG は上限に収まる', () => {
  const f = makeFrame(2, 2)
  const bmp = bmpBytes(f)
  expect(String.fromCharCode(bmp[0]!, bmp[1]!)).toBe('BM')
  // 1 行 6 バイトを 8 バイトに詰める
  expect(bmp.length).toBe(54 + 8 * 2)
  // ファイルの最初の画素は、絵の左下 (2 番目の画素 = i 2)
  expect([bmp[54], bmp[55], bmp[56]]).toEqual([0x40, 0, 2])
  const big = frameSvg(makeFrame(SVG_FRAME.w, SVG_FRAME.h))
  expect(big.length).toBeLessThan(131072)
  expect(big).not.toMatch(/<svg[^>]* width=/)
})

test('terminal の絵の大きさ: 幅に合わせ、縦は 2 の倍数', () => {
  expect(terminalFrameSize(120)).toEqual({ w: 120, h: 90 })
  expect(terminalFrameSize(29)).toEqual({ w: 32, h: 24 })
  expect(terminalFrameSize(999).w).toBe(200)
  for (const c of [33, 57, 101]) expect(terminalFrameSize(c).h % 2).toBe(0)
})

test('打った文字を DOOM のキーに変える', () => {
  expect(keysForChar('w')).toEqual([DK.up])
  expect(keysForChar('W')).toEqual([DK.shift, DK.up])
  expect(keysForChar(' ')).toEqual([DK.use])
  expect(keysForChar('m')).toEqual([DK.escape])
  expect(keysForChar('y')).toEqual([121])
  expect(keysForChar('3')).toEqual([51])
  expect(keysForChar('8')).toEqual([])
  expect(keysForChar('あ')).toEqual([])
})

test('入力欄の変化から、新しく打った文字だけを取り出す', () => {
  expect(typedSince('', 'w')).toBe('w')
  expect(typedSince('ww', 'www')).toBe('w')
  expect(typedSince('www', 'a')).toBe('a')
  expect(typedSince('ww', '')).toBe('')
  expect(typedSince('ww', 'ww')).toBe('')
})

test('同じキーをゆっくり 2 回: 欄は打たれたとおりに描くので、2 回目も新しい文字になる', () => {
  let shown = ''
  let typed = ''
  const out: string[] = []
  for (const now of ['w', 'ww']) {
    out.push(typedSince(typed, now))
    typed = now
    shown = fieldValue(typed)
  }
  expect(out).toEqual(['w', 'w'])
  expect(shown).toBe('ww')
  // 長くなったら空に戻す。戻った後の 1 文字目も拾う
  const long = 'w'.repeat(40)
  expect(fieldValue(long)).toBe('')
  expect(typedSince(long, 'a')).toBe('a')
  // 空に戻るのが間に合わず、続けて足された時は足した分だけ
  expect(typedSince(long, `${long}d`)).toBe('d')
})

test('キーファイルの形', () => {
  expect(keyFileText(160, 120, [{ seq: 1, key: 173 }, { seq: 2, key: 27 }])).toBe('HP1 160 120 0\n1 173\n2 27\nEND\n')
  expect(keyFileText(80, 60, [], true)).toBe('HP1 80 60 1\nEND\n')
})

/** エンジンを作り物にして、/doom を開く。絵を 2 枚出したあとは止められるまで待つ */
const boot = async ($: Engine, on: On, surface: 'vscode' | 'terminal') => {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  const writes: { path: string; text: string }[] = []
  const spawned: string[][] = []
  let finish = () => {}
  const done = new Promise<void>(r => (finish = r))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: `Doom Generic 0.1\n${lineOf(makeFrame(4, 4))}\n` }
    yield { stream: 'stdout' as const, text: `${lineOf(makeFrame(4, 4))}\n` }
    await done
    return { value: { code: 0, signal: null } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/tmp/demo', surface, isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface })
  const run = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
  const res = await $.command.run({ command: 'doom', ...run })
  return { ui, writes, spawned, finish, res }
}

for (const surface of SURFACES) {
  test(`${surface}: /doom でエンジンを起こし、絵を描き、打った文字をキーファイルに書く`, async ($, on) => {
    const { ui, writes, spawned, finish, res } = await boot($, on, surface)
    expect(res.text).toMatch(/HellPane を開きました/)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.slice(1)).toEqual(expect.arrayContaining(['-iwad', '-hpkeys', 'C:/Users/demo/.hellpane/keys.txt']))

    const type = surface === 'vscode' ? 'Svg' : 'Raster'
    let screen
    for (let i = 0; i < 200 && !screen; i++) screen = await ui.find({ type })
    expect(screen).toBeDefined()
    if (surface === 'vscode') expect(String(screen?.props.source)).toMatch(/data:image\/bmp;base64,/)
    else expect(screen?.props.columns).toBe(4)

    await ui.input({ key: 'keys', text: 'w', kind: 'change' })
    await ui.input({ key: 'keys', text: 'wW', kind: 'change' })
    await ui.press({ key: 'k-撃つ' })
    let last = ''
    for (let i = 0; i < 200; i++) {
      last = writes.at(-1)?.text ?? ''
      if (last.includes(`4 ${DK.fire}`)) break
      await ui.find({ key: 'keys' })
    }
    expect(last).toBe(`HP1 ${surface === 'vscode' ? '160 120' : '32 24'} 0\n1 ${DK.up}\n2 ${DK.shift}\n3 ${DK.up}\n4 ${DK.fire}\nEND\n`)

    await ui.press({ key: 'stop' })
    for (let i = 0; i < 200 && !(writes.at(-1)?.text ?? '').startsWith('HP1') ; i++) await ui.find({ key: 'keys' })
    expect(writes.at(-1)?.text).toMatch(/^HP1 \d+ \d+ 1\n/)
    finish()
  })
}

test('エンジンか WAD が無ければ起こさず、場所を出す', async ($, on) => {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  let spawned = 0
  on('process.spawn', async function* () {
    spawned++
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp/demo', surface: 'vscode', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const run = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
  await $.command.run({ command: 'doom', ...run })
  expect(spawned).toBe(0)
  const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
  const note = texts.find(x => x.startsWith('エンジンが見つかりません: '))
  // どこにも無ければ、置いてほしいデータフォルダの場所を出す
  expect(note).toBe('エンジンが見つかりません: C:/Users/demo/.hellpane/hellpane-engine.exe')
  // パスの区切りを混ぜない
  expect(note?.includes('\\') && note.includes('/')).toBe(false)
  expect(await ui.find({ key: 'start' })).toBeDefined()
})

test('/doom が取れなければ /hell-pane で開き、元の /doom は横取りしない', async ($, on) => {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const tried: string[] = []
  on('command.register', (_$, e) => {
    tried.push(e.name)
    return e.name === 'doom' ? { deny: 'ほかの mod と被っています' } : { value: { command: e.name } }
  })
  let opened = ''
  on('ui.open', (_$, e) => {
    opened = e.id
    return { value: { isPlaced: true as const } }
  })
  let passedOn = false
  on('command.run', { command: 'doom' }, () => {
    passedOn = true
    return { text: '元の /doom' }
  })
  await $.session.start({ cwd: '/tmp/demo', surface: 'vscode', isInteractive: true })
  expect(tried).toEqual(['doom', 'hell-pane'])
  const run = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
  expect((await $.command.run({ command: 'doom', ...run })).text).toBe('元の /doom')
  expect(passedOn).toBe(true)
  expect(opened).toBe('')
  expect((await $.command.run({ command: 'hell-pane', ...run })).text).toMatch(/HellPane を開きました/)
  expect(opened).toBe('hell-pane')
})
