# HaruharuHaptic

Audio + HHT (Haruharu Haptic Timestamp) + Web Vibration API.

- `haruharuhaptics.js`: `<audio hht-href="...">` を検出して `.hht`（独自バイナリ）を読み込み、音源再生に同期して `navigator.vibrate()` をパルス列で鳴らします。
- GitHub Actions + Python で `audio/*.m4a` → `exports/*.hht` を生成し、**リポジトリにコミット**します。

## 使い方（Web）

HTML:

```html
<audio src="/audio/a.m4a" hht-href="/exports/a.hht" controls></audio>
<script src="/haruharuhaptics.js"></script>
```

- スマホで「再生」ボタンを押す（ユーザー操作）と振動が出ます。
- `navigator.vibrate` が無い環境では何もしません。

## HHT バイナリ仕様（v1）

狙い：安いスマホでも **ArrayBuffer → DataView** で高速パースできること。

### ヘッダ（16 bytes, little-endian）

| Offset | Size | Type | Name | Notes |
|---:|---:|---|---|---|
| 0 | 4 | bytes | magic | ASCII `HHT1` |
| 4 | 1 | u8 | version | `1` |
| 5 | 1 | u8 | flags | `0` |
| 6 | 2 | u16 | reserved | `0` |
| 8 | 4 | u32 | timebase_hz | `1000`（タイムスタンプは ms） |
| 12 | 4 | u32 | event_count | イベント数 |

### イベント（8 bytes × event_count, little-endian）

| Offset | Size | Type | Name | Notes |
|---:|---:|---|---|---|
| 0 | 4 | u32 | t | 開始時刻（timebase単位。ms） |
| 4 | 2 | u16 | d | duration（ms） |
| 6 | 1 | u8 | i | intensity 0..255 |
| 7 | 1 | u8 | kind | 0 = vibrate |

## “鳴りっぱなし”を避ける方針（パルス列）

ブラウザの振動APIは高精度・連続制御が難しいので、低域エネルギーを「短パルス列」に変換します。

- 低域が弱いところはガンマ補正でさらに弱くして、常時ブーンを抑制
- 最小ギャップを設けて常時振動化を回避
- JS 側でもパルス列に変換し、過剰発火を制限

## GitHub Actions で HHT を生成（audio/*.m4a → exports/*.hht）

1. `audio/` に `a.m4a` を置く
2. Actions の **Generate HHT** を実行（または audio/ を push）
3. `exports/a.hht` が生成されコミットされます

## 注意（ブラウザ差）

- `navigator.vibrate` はユーザー操作後でないと動かない場合があります（再生ボタン操作が必要）。
- iOS Safari は振動の対応が限定的/非対応の場合があります。主に Android Chrome を想定。
