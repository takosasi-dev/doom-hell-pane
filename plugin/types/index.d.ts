/** エンジン (hellpane-engine.exe) の様子 */
export type EngineStatus = 'idle' | 'running' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'hell-pane': {
      status: EngineStatus
      /** 止まった理由や見つからないファイル。空なら出さない */
      note: string
    }
  }
}
