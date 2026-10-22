# Changelog

## [0.1.0] - 2026-10-22

### Added

- hell-pane 0.1.0: `/doom` で DOOM をペインに出す mod(`/doom` が被った時は `/hell-pane`)。VS Code は SVG、ターミナルは文字マスのドット絵で描く
- 入力欄に打った文字を DOOM のキーに変える操作(WASD・Q/E・J/F・K・1〜7・M・Enter・Y/N・V)と、止める・メニュー・決定・撃つ・使う・地図のボタン
- doomgeneric の Windows 用の部品 `engine/doomgeneric_hellpane.c`: 絵を標準出力へ 1 行 1 枚で書き、キーをファイルから読む。キーを離したことは、押されない時間で決める
- エンジンと WAD は、設定 → mod の `bin`・`wad` → `%USERPROFILE%\.hellpane` の順に探す
