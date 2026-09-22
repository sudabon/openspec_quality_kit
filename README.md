# openspec-quality-kit

OpenSpec プロジェクトに「正しさの定義 → 独立した検証 → 証跡」の Quality Engineering ワークフローを
1 コマンドで組み込む bootstrap kit。カスタムスキーマ・AI Quality Policy・Oracle の seal ゲート・
独立検証用サブエージェントを配布物 (`payload/`) として持ち、インストーラが対象リポジトリへ冪等にコピーする。

`openspec update` で再生成される `.claude/commands/opsx/` や `.claude/skills/openspec-*` には一切触れないので、
OpenSpec 本体のアップグレードで設定が飛ぶことがない。

## 導入

`openspec init` の前でも後でも導入できる。

### openspec init の前に導入する場合

```
npx github:sudabon/openspec_quality_kit --language Japanese
openspec init --tools claude          # --language は付けない
```

kit が `openspec/config.yaml` を作成するため、その後の `openspec init` に `--language` を付けると
**エラーで中断する**(OpenSpec は既存の config を `--language` で上書きしない)。
言語は kit の `--language` で指定する。`openspec init` は既存の config.yaml とカスタムスキーマを保持したまま初期化する。

### openspec init の後に導入する場合

```
openspec init --tools claude --language Japanese
npx github:sudabon/openspec_quality_kit
```

`openspec init` が書いた `schema: spec-driven` を `quality-driven` に切り替える。
進行中の change は各自の `.openspec.yaml` にスキーマを記録しているので影響を受けない。

### オプション

```
npx github:sudabon/openspec_quality_kit install --target /path/to/repo
npx github:sudabon/openspec_quality_kit --dry-run          # 書き込まず、実行予定だけ表示
```

```
usage: openspec-quality-kit [install|update] [--force] [--dry-run] [--target <dir>] [--language <lang>]
```

## 更新

```
npx github:sudabon/openspec_quality_kit update
```

同一内容のファイルは黙って skip される。対象側で内容が変わっているファイルは **上書きせず** unified diff を表示して skip する。
kit 側に揃えたい場合だけ `--force` を付ける。

`openspec/quality-policy.md` はプロジェクトごとに編集する前提のファイルなので、存在すれば `--force` でも上書きしない。
kit の最新版に戻したい場合は削除してから再実行する。

## 導入されるもの

| 配置先 | 内容 |
|--------|------|
| `openspec/schemas/quality-driven/` | `spec-driven` を fork し `quality` アーティファクトを追加したカスタムスキーマ。tasks を Oracle → 実装 → Falsification → Evidence の順に構成し、apply に Reward Hacking 防止ルールを持つ |
| `openspec/quality-policy.md` | AI Quality Policy(Risk Level 定義、Quality Gate マトリクス、禁止パターン)。初回のみ作成 |
| `scripts/qe-gate.sh` | 承認・Oracle の seal・証跡を検査する決定的ゲート(CI 用)。`seal` サブコマンドは人間が実行する |
| `.claude/agents/qe-oracle-writer.md` | specs と quality.md だけから Oracle テストを書くサブエージェント |
| `.claude/agents/qe-falsifier.md` | 実装が間違っていることを証明するテストを書く反証サブエージェント |
| `.github/CODEOWNERS.example` | Oracle と品質基盤を人間レビュー必須にする CODEOWNERS の例 |
| `openspec/config.yaml` | `schema: quality-driven` の設定(新規作成時は `--language` の context も) |
| `.openspec-quality-kit.json` | 導入した kit のバージョンと導入時刻 |

導入先の `.gitignore` で kit のファイルが無視される場合は警告を出す。特に `.claude/` を丸ごと無視していると
サブエージェントがチームに共有されない。`!.claude/agents/` を足すだけでは効かない(親ディレクトリごと除外されるため)ので、次のように書き換える。

```gitignore
/.claude/*
!/.claude/agents/
```

`openspec/config.yaml` の `context` には触らない。品質ルールはスキーマの instruction が持つので、
他の kit が context にマーカーブロックを持っていても衝突しない。

`schema:` が `spec-driven` 以外(例: `spec-driven-e2e`)に設定されている場合は**変更せず警告のみ**表示する。
change 単位で使う場合は `openspec new change <name> --schema quality-driven`。

## 導入後の開発フロー

1. **propose** — `proposal → specs → quality → design → tasks` の順にアーティファクトが作られる。
   `quality.md` は Risk / Failure Mode / Oracle / Test Layer / Quality Gate / Residual Risk を定義する。
2. **quality レビュー** — ここが人間のレビューポイント。Oracle の観測点が具体的か
   (ステータスコードや存在確認だけで終わっていないか)を見て、`approved_by` / `approved_at` を記入する。
3. **apply(Oracle)** — `## 1. Oracle` を qe-oracle-writer が別コンテキストで実装し、RED を確認する。
4. **seal** — 人間が Oracle をレビューし `scripts/qe-gate.sh seal <change>` を実行する。
5. **apply(実装 → Falsification → Evidence)** — 実装後、qe-falsifier が反証テストを書き、`evidence.md` で全 Risk ID の証跡を残す。
6. **archive** — CI が `evidence.md` の Risk 網羅を検査する。

## CI ゲート

reusable workflow を呼び出すスタブを、対象リポジトリの `.github/workflows/` に置く。

```yaml
name: quality-gate
on: [pull_request]
jobs:
  quality-gate:
    uses: sudabon/openspec_quality_kit/.github/workflows/openspec-quality-gate.yml@main
    with:
      test-command: npm test                 # 既存 CI でテストを回しているなら省略可
      mutation-command: npx stryker run      # risk_level=high の change を含む PR で必須
      # working-directory: frontend
```

ゲートがブロックする条件:

- tasks.md があるのに quality.md がない
- quality.md が未承認のままタスクが完了扱いになっている
- risk_level が medium / high で、seal 前に実装タスクが完了扱いになっている
- seal 後に Oracle テストが変更・リネーム・削除された
- アーカイブ時に未完了タスクがある / evidence.md がない / evidence.md に載っていない Risk ID がある
- risk_level=high の change を含むのに `mutation-command` が未指定、または閾値未満

reusable workflow は**呼び出し側リポジトリの文脈で動く**ため、kit が導入済み(`scripts/qe-gate.sh` が存在)であることが前提。

`approved_by` と seal はガードレールであり改ざん防止ではない。`.github/CODEOWNERS.example` を参考に
CODEOWNERS とブランチ保護("Require review from Code Owners")を設定して完成する。

## OpenSpec をアップグレードしたとき

`quality-driven` はビルトインスキーマ(OpenSpec 1.13.1)の fork なので、upstream の改善は自動では取り込まれない。
アップグレード後は kit 側で `spec-driven` を再 fork し、次の差分を当て直して `update` で配り直す。

- `quality` アーティファクトの追加
- `design` の requires に `quality`、instruction に Oracle の観測可能性
- `tasks` の requires に `quality`、instruction に Quality-driven structure と例
- `apply` の instruction に品質ルール

`schema validate` は構造しか見ないため、`npm test` の (a) で実際の change の依存関係と instruction まで検証している。

## kit 自体の開発

```
npm test    # test/selftest.sh。/tmp にサンドボックスを作り、init 前後の導入・冪等性・差分 skip・qe-gate を検証
```

外部 dependencies は持たない(インストーラは Node 標準ライブラリのみ)。`openspec` CLI が無い環境では連携部分の検証だけ skip される。
