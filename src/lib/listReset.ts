// リスト（ul）の既定の字下げと黒丸を確実に消すインラインスタイル。
// Tailwind の基本スタイル（preflight）は CSS の layer の中にあるため、layer の外で読み込む CSS（Mobiscroll など）が
// ul に余白を付けると負けて、一覧が右にずれる。インラインスタイルはどの CSS よりも優先される。
// 上下の余白（mt-* などのクラス）は打ち消さないよう、左の余白と黒丸だけを指定する。
import type { CSSProperties } from 'react';

export const LIST_RESET: CSSProperties = { paddingLeft: 0, listStyle: 'none' };
