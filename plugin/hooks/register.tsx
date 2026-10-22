import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EngineStatus } from '../types'
import {
  DK,
  fieldValue,
  frameSvg,
  KEEP_PRESSES,
  keyFileText,
  keysForChar,
  rasterCells,
  SVG_FRAME,
  takeLatestFrame,
  terminalFrameSize,
  typedSince,
} from './frame'
import type { Frame, KeyPress } from './frame'

type $ = EngineInterface

const PANE = 'hell-pane'
const TITLE = 'DOOM（HellPane）'
const DESCRIPTION = 'DOOM をペインで遊ぶ (HellPane)。入力欄に WASD で操作'

const STATUS = atom({ plugin: 'hell-pane', key: 'status' } as const, 'idle' as EngineStatus)
const NOTE = atom({ plugin: 'hell-pane', key: 'note' } as const, '')

const HELP = [
  'W/S 前後  A/D 向き  Q/E 横歩き  大文字で走る',
  'J か F で撃つ  K かスペースで使う(扉)  1〜7 武器',
  'M メニュー  Enter 決定  Y/N はい・いいえ  V 地図',
]

// 絵とキーはモジュールの変数に置く。1 秒に何回も変わる大きな値なので、$.state には置かない。
// リロードで消えるが、そのときはエンジンも止まる (spawn のループがモジュールと一緒に終わる)
let latest: Frame | null = null
let presses: KeyPress[] = []
let seq = 0
let lastTyped = ''
let size: { w: number; h: number } = { w: SVG_FRAME.w, h: SVG_FRAME.h }
let surface: string = 'vscode'
let bodyColumns = 80
let isRunning = false
/** /doom を登録できた (できなければ /hell-pane だけ) */
let ownsDoom = false
let stopRequested = false
let writing: Promise<unknown> = Promise.resolve()
let paths = { engine: '', wad: '', data: '', keys: '' }

const trimSlash = (p: string) => p.trim().replace(/[\\/]+$/, '')

let opts: Record<string, unknown> = {}

const resolvePaths = async ($: $) => {
  const root = trimSlash($.plugin.root)
  // 区切りは元のパスに合わせる (Windows のパスに / を混ぜない)
  const join = (dir: string, ...names: string[]) => [dir, ...names].join(dir.includes('\\') ? '\\' : '/')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? root
  const data = trimSlash(String(opts.dataDir ?? '')) || join(trimSlash(home), '.hellpane')
  // 設定が空なら、プラグインの bin・wad → データフォルダの順に探す。どちらにも無ければデータフォルダの方を出す
  const pick = async (set: unknown, inPlugin: string, name: string) => {
    const given = trimSlash(String(set ?? ''))
    if (given) return given
    const own = join(root, inPlugin, name)
    return (await $.fs.stat(own).then(() => true, () => false)) ? own : join(data, name)
  }
  paths = {
    engine: await pick(opts.enginePath, 'bin', 'hellpane-engine.exe'),
    wad: await pick(opts.wadPath, 'wad', 'freedoom1.wad'),
    data,
    keys: join(data, 'keys.txt'),
  }
}

/** キーファイルを書き直す。書く順が入れ替わらないよう 1 本の列に並べる */
const writeKeys = ($: $, quit = false) => {
  const text = keyFileText(size.w, size.h, presses, quit)
  writing = writing.then(() => $.fs.write(paths.keys, text)).catch(() => {})
  return writing
}

const press = ($: $, keys: number[]) => {
  if (!isRunning || keys.length === 0) return
  for (const key of keys) presses.push({ seq: ++seq, key })
  if (presses.length > KEEP_PRESSES) presses = presses.slice(-KEEP_PRESSES)
  void writeKeys($)
}

const wantedSize = () => (surface === 'terminal' ? terminalFrameSize(bodyColumns) : { w: SVG_FRAME.w, h: SVG_FRAME.h })

/** 絵が届いた。terminal は Raster を塗り替え、vscode は描き直しを頼む (1 秒に 10 回までにまとめられる) */
const paint = async ($: $, f: Frame) => {
  const before = latest
  latest = f
  if (surface === 'terminal' && before && before.w === f.w && before.h === f.h) {
    const c = rasterCells(f)
    const r = await $.ui.blit({ requestId: PANE, key: 'screen', columns: c.columns, rows: c.rows, cells: c.cells }).catch(() => ({ deny: 'blit' }))
    if (!('deny' in r)) return
  }
  $.ui.invalidate('ui.render')
}

const start = async ($: $) => {
  if (isRunning) return
  await resolvePaths($)
  for (const [what, p] of [['エンジン', paths.engine], ['WAD', paths.wad]] as const) {
    const ok = await $.fs.stat(p).then(() => true, () => false)
    if (!ok) {
      await update($, STATUS, () => 'error')
      await update($, NOTE, () => `${what}が見つかりません: ${p}`)
      return
    }
  }
  isRunning = true
  stopRequested = false
  latest = null
  presses = []
  seq = 0
  size = wantedSize()
  await writeKeys($)
  await update($, STATUS, () => 'running')
  await update($, NOTE, () => '')
  $.ui.invalidate('ui.render')

  // エンジンはセッションの間ずっと動く。ループを抜けるとエンジンも止まる
  void (async () => {
    let buffer = ''
    let errTail = ''
    let code: number | null = null
    try {
      const child = $.process.spawn({
        argv: [paths.engine, '-iwad', paths.wad, '-hpkeys', paths.keys, '-hpw', String(size.w), '-hph', String(size.h)],
        cwd: paths.data,
      })[Symbol.asyncIterator]()
      for (;;) {
        const step = await child.next()
        if (step.done) {
          code = step.value?.code ?? null
          break
        }
        // 止める時は抜ける (return でエンジンも止まる)
        if (stopRequested) {
          await child.return?.({ code: null, signal: null })
          break
        }
        const chunk = step.value
        if (chunk.stream === 'stderr') {
          errTail = (errTail + chunk.text).slice(-400)
          continue
        }
        buffer += chunk.text
        const { frame, rest } = takeLatestFrame(buffer)
        buffer = rest
        if (frame) await paint($, frame)
      }
    } catch (err) {
      errTail = String(err)
    } finally {
      isRunning = false
    }
    const wasStopped = stopRequested
    const why = errTail.trim().split('\n').pop() ?? ''
    // セッションやモジュールが先に終わっていれば、書けなくてもよい
    try {
      await update($, STATUS, () => (wasStopped || code === 0 ? 'idle' : 'error'))
      await update($, NOTE, () => (wasStopped ? '止めました' : why ? `エンジンが止まりました: ${why}` : 'エンジンが止まりました'))
      $.ui.invalidate('ui.render')
    } catch {}
  })()
}

const stop = async ($: $) => {
  if (!isRunning) return
  stopRequested = true
  await writeKeys($, true)
}

const openPane = async ($: $) => {
  await $.ui.open({ id: PANE, title: TITLE })
  await start($)
  return { text: 'HellPane を開きました。入力欄をクリックして WASD で動けます。' }
}

export const register: Register = (on, options) => {
  opts = options

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // /doom が拒まれたら (ほかと被ったら) /hell-pane にする
    const got = await $.command.register({ name: 'doom', description: DESCRIPTION }).catch(() => undefined)
    ownsDoom = got?.command === 'doom'
    if (!ownsDoom) await $.command.register({ name: 'hell-pane', description: DESCRIPTION }).catch(() => {})
    return started
  })

  // /doom を持てなかった時は、元の /doom に回す
  on('command.run', { command: 'doom' }, ($, e, next) => (ownsDoom ? openPane($) : next(e))).catch(($, e, next) => next(e))
  on('command.run', { command: 'hell-pane' }, openPane)

  // ペインを閉じたらエンジンも止める
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await stop($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const isTerminal = e.surface === 'terminal'
    surface = e.surface
    bodyColumns = e.props.bodyColumns
    const status = await read($, STATUS)
    const note = await read($, NOTE)

    // 画面の種類や幅が変わったら、エンジンに絵の大きさを伝え直す
    const want = wantedSize()
    if (isRunning && (want.w !== size.w || want.h !== size.h)) {
      size = want
      void writeKeys($)
    }

    let screen
    if (!latest) {
      screen = <Text key="screen-wait" dimColor>{status === 'running' ? '起動中…' : '止まっています'}</Text>
    } else if (isTerminal && 'Raster' in t) {
      const c = rasterCells(latest)
      screen = <t.Raster key="screen" columns={c.columns} rows={c.rows} cells={c.cells} />
    } else if (!isTerminal && 'Svg' in t) {
      screen = <t.Svg key="screen" source={frameSvg(latest)} alt="DOOM の画面" />
    } else {
      screen = <Text key="screen-none" dimColor>この画面では絵を描けません</Text>
    }

    const onInput = (value: string) => {
      const typed = typedSince(lastTyped, value)
      lastTyped = value
      press($, [...typed].flatMap(keysForChar))
    }
    const onSubmit = (value: string) => {
      onInput(value)
      press($, [DK.enter])
    }
    const keyButton = (label: string, keys: number[]) => (
      <Button key={`k-${label}`} label={label} onPress={() => press($, keys)} />
    )

    return (
      <Box flexDirection="column" gap={1}>
        {screen}
        {note ? <Text key="note" color={status === 'error' ? 'error' : undefined}>{note}</Text> : null}
        <Input t={t} running={status === 'running'} value={fieldValue(lastTyped)} onInput={onInput} onSubmit={onSubmit} />
        <Box key="buttons" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {status === 'running' ? (
            <Button key="stop" label="止める" onPress={() => void stop($)} />
          ) : (
            <Button key="start" label="始める" onPress={() => void start($)} />
          )}
          {keyButton('メニュー', [DK.escape])}
          {keyButton('決定', [DK.enter])}
          {keyButton('撃つ', [DK.fire])}
          {keyButton('使う', [DK.use])}
          {keyButton('地図', [DK.tab])}
        </Box>
        <Box key="help" flexDirection="column">
          {HELP.map(line => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

/** 操作の入力欄。打った文字はすぐキーに変わる。欄は打たれたとおりに描き (描き直しで欄が戻って同じキーの 2 回目を落とさないよう)、長くなったら空にする */
const Input = (p: { t: ReturnType<EngineInterface['ui']['resolve']>; running: boolean; value: string; onInput: (v: string) => void; onSubmit: (v: string) => void }) => {
  if (!('Input' in p.t)) return null
  const I = p.t.Input
  return (
    <I
      key="keys"
      label="操作"
      placeholder={p.running ? 'ここをクリックして WASD' : '始めると打てます'}
      value={p.value}
      submitLabel="決定"
      onInput={p.onInput}
      onSubmit={p.onSubmit}
    />
  )
}
