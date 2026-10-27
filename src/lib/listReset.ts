// リスト（ul / li）の既定の字下げ・左右の余白・黒丸を確実に消すインラインスタイル。
// Tailwind の基本スタイル（preflight）は CSS の layer の中にあるため、layer の外で読み込む CSS（Mobiscroll など）が
// ul / li に余白（padding / margin）を付けると負けて、一覧が右にずれ横幅も狭くなる。インラインスタイルはどの CSS よりも優先される。
// 上下の余白（mt-* などのクラス）は打ち消さないよう、左右だけを指定する。
import type { CSSProperties } from 'react';

export const LIST_RESET: CSSProperties = { paddingLeft: 0, paddingRight: 0, marginLeft: 0, marginRight: 0, listStyle: 'none' };
// li 用。左右の余白だけを消す（li の padding は各カードのクラスで付けるので触らない）。
export const LIST_ITEM_RESET: CSSProperties = { marginLeft: 0, marginRight: 0 };
