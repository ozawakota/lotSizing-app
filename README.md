# FX Lot Size Calculator

FXトレードにおける適正ロットサイズを計算するWebアプリです。

## 概要

証拠金・リスク許容度・損切り幅・通貨ペア・レバレッジを入力することで、リスク管理に基づいた推奨ロットサイズを即座に算出します。日本語UIで、スマートフォンでの利用を主に想定しています。

## 主な機能

- **ロットサイズ計算**: リスク%とストップロス幅（pips）から適正ロット数を算出
- **証拠金通貨対応**: 日本円（JPY）・米ドル（USD）に対応
- **通貨ペア対応**: JPY / USD / EUR / GBP / AUD / NZD / CAD / CHF
- **レバレッジ選択**: 1倍〜1000倍まで対応
- **証拠金維持率の表示**: ポジション保有時の証拠金維持率を自動計算
- **為替レート取得**: Alpha Vantage APIによるリアルタイムレート更新（手動トリガー）
- **損失許容額の表示**: JPY/USD両建てで参考表示

## 技術スタック

| カテゴリ | 使用技術 |
|---|---|
| フレームワーク | React 19 + TypeScript 5.7 |
| ビルドツール | Vite 6 |
| スタイリング | Tailwind CSS v4 |
| UIコンポーネント | Mobiscroll React, Radix UI, shadcn/ui |
| デプロイ | GitHub Pages |

## セットアップ

```bash
npm install
npm run dev
```

## 主なコマンド

```bash
npm run dev       # 開発サーバー起動
npm run build     # 型チェック + プロダクションビルド
npm run lint      # ESLintチェック
npm run preview   # ビルド結果のプレビュー
npm run deploy    # GitHub Pagesへデプロイ
```

## 注意事項

- 計算結果はあくまで参考値です。実際の取引は自己責任で行ってください。
- Alpha Vantage APIの無料プランは1分あたり5リクエストの制限があります。
