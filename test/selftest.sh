#!/usr/bin/env bash
# openspec-quality-kit セルフテスト。/tmp にサンドボックスを作って検証する。
set -uo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oqk-selftest.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

pass=0; fail=0; skipped=0
ok()   { echo "  ✓ $*"; pass=$((pass + 1)); }
ng()   { echo "  ✗ $*"; fail=$((fail + 1)); }
skip() { echo "  - $* (skip)"; skipped=$((skipped + 1)); }
step() { echo; echo "▶ $*"; }
has_openspec() { command -v openspec >/dev/null 2>&1; }
install_kit() { node "$KIT/install.mjs" "$@" 2>&1; }
new_repo() { local d="$ROOT/$1"; mkdir -p "$d"; git -C "$d" init -q; echo "$d"; }
commit_all() { git -C "$1" add -A && git -C "$1" -c user.email=t@t -c user.name=t commit -qm "$2" --allow-empty; }

# ---------------------------------------------------------------------------
step "(a) openspec init より前に導入する"
pre="$(new_repo pre)"
out="$(install_kit --target "$pre" --language Japanese)"
grep -q '^schema: quality-driven' "$pre/openspec/config.yaml" && ok "config.yaml を schema: quality-driven で新規作成" || ng "config.yaml の schema"
grep -q 'Language: Japanese' "$pre/openspec/config.yaml" && ok "--language の context を書き込み" || ng "language context がない"
echo "$out" | grep -q 'openspec init --tools' && ok "未初期化を検出し、次に init するよう案内" || ng "init の案内がない"
[[ -x "$pre/scripts/qe-gate.sh" ]] && ok "qe-gate.sh に実行ビット" || ng "qe-gate.sh が実行可能でない"

if has_openspec; then
  init_out="$(cd "$pre" && openspec init --tools claude --no-animation . 2>&1)"; rc=$?
  [[ $rc -eq 0 ]] && ok "導入後の openspec init(--language なし)が成功" || ng "openspec init 失敗: $init_out"
  grep -q '^schema: quality-driven' "$pre/openspec/config.yaml" && grep -q 'Language: Japanese' "$pre/openspec/config.yaml" \
    && ok "init 後も config.yaml が保持される" || ng "init が config.yaml を書き換えた"
  (cd "$pre" && openspec schema validate quality-driven >/dev/null 2>&1) && ok "openspec schema validate quality-driven" || ng "schema validate 失敗"
  (cd "$pre" && openspec new change demo >/dev/null 2>&1)
  st="$(cd "$pre" && openspec status --change demo 2>&1)"
  echo "$st" | grep -q 'quality (blocked by: specs)' && echo "$st" | grep -q 'design (blocked by: proposal, quality)' \
    && ok "artifact の依存関係が proposal → specs → quality → design → tasks" || ng "依存関係が想定と違う: $st"
  ins="$(cd "$pre" && openspec instructions quality --change demo 2>&1)"
  echo "$ins" | grep -q 'Language: Japanese' && echo "$ins" | grep -q 'quality-policy.md' \
    && ok "quality の instruction に context とポリシー参照が入る" || ng "quality instruction が不完全"
  (cd "$pre" && openspec update --force . >/dev/null 2>&1)
  [[ -f "$pre/.claude/agents/qe-oracle-writer.md" && -f "$pre/.claude/agents/qe-falsifier.md" ]] \
    && ok "openspec update --force 後もサブエージェントが残る" || ng "openspec update がサブエージェントを消した"
else
  skip "openspec CLI が無いため init 連携の検証を省略"
fi

# ---------------------------------------------------------------------------
step "(b) openspec init の後に導入する"
post="$(new_repo post)"
if has_openspec; then
  (cd "$post" && openspec init --tools claude --language Japanese --no-animation . >/dev/null 2>&1)
  out="$(install_kit --target "$post")"
  grep -q '^schema: quality-driven' "$post/openspec/config.yaml" && ok "schema: spec-driven → quality-driven に切り替え" || ng "schema が切り替わらない"
  grep -q 'Language: Japanese' "$post/openspec/config.yaml" && ok "init が書いた context を保持" || ng "context が消えた"
  echo "$out" | grep -q 'openspec init --tools' && ng "初期化済みなのに init を案内している" || ok "初期化済みを検出"
else
  mkdir -p "$post/openspec/specs"; printf 'schema: spec-driven\n' > "$post/openspec/config.yaml"
  install_kit --target "$post" >/dev/null
  grep -q '^schema: quality-driven' "$post/openspec/config.yaml" && ok "schema: spec-driven → quality-driven に切り替え" || ng "schema が切り替わらない"
fi

# ---------------------------------------------------------------------------
step "(c) 冪等性"
commit_all "$post" base
out="$(install_kit --target "$post" update)"
[[ -z "$(git -C "$post" status --porcelain)" ]] && ok "2回目の update で差分が出ない" || ng "2回目で差分: $(git -C "$post" status --porcelain)"
echo "$out" | grep -q '既に最新です' && ok "「既に最新」と表示" || ng "最新表示がない"

# ---------------------------------------------------------------------------
step "(d) 対象側の変更は上書きしない"
echo '# local change' >> "$post/scripts/qe-gate.sh"
echo '| extra | 独自定義 |' >> "$post/openspec/quality-policy.md"
out="$(install_kit --target "$post" update)"
echo "$out" | grep -q '差分あり(上書きしません): scripts/qe-gate.sh' && ok "差分を表示して skip" || ng "差分表示がない"
tail -1 "$post/scripts/qe-gate.sh" | grep -q 'local change' && ok "qe-gate.sh は保持" || ng "qe-gate.sh が上書きされた"
install_kit --target "$post" update --force >/dev/null
tail -1 "$post/scripts/qe-gate.sh" | grep -q 'local change' && ng "--force で上書きされない" || ok "--force で上書き"
tail -1 "$post/openspec/quality-policy.md" | grep -q '独自定義' && ok "quality-policy.md は --force でも保持" || ng "quality-policy.md が上書きされた"

# ---------------------------------------------------------------------------
step "(e) 別のカスタムスキーマが既定の場合"
other="$(new_repo other)"
mkdir -p "$other/openspec"; printf 'schema: spec-driven-e2e\n' > "$other/openspec/config.yaml"
out="$(install_kit --target "$other")"
grep -q '^schema: spec-driven-e2e' "$other/openspec/config.yaml" && ok "既存の schema を変更しない" || ng "schema を書き換えた"
echo "$out" | grep -q "自動変更しません" && ok "警告を表示" || ng "警告がない"

# ---------------------------------------------------------------------------
step "(f) dry-run"
dry="$(new_repo dry)"
install_kit --target "$dry" --dry-run >/dev/null
[[ -z "$(ls -A "$dry" | grep -v '^.git$')" ]] && ok "何も書き込まない" || ng "dry-run で書き込んだ"

# ---------------------------------------------------------------------------
step "(g) qe-gate: 承認・seal・改ざん検知・証跡"
g="$pre"
if has_openspec; then
  C="$g/openspec/changes/demo"
  cp "$g/openspec/schemas/quality-driven/templates/quality.md" "$C/quality.md"
  sed -i.bak -e 's/^risk_level: medium /risk_level: high   /' -e 's#^oracle_paths: \[\] #oracle_paths: ["tests/oracle/demo/"]#' \
    -e 's/^| R1 |        |/| R1 | 二重配信 |/' "$C/quality.md" && rm -f "$C/quality.md.bak"
  printf '# Tasks\n## 1. Oracle\n- [ ] 1.1 O1\n- [ ] 1.2 seal\n## 2. Impl\n- [ ] 2.1 impl\n' > "$C/tasks.md"
  gate() { (cd "$g" && bash scripts/qe-gate.sh "$@" 2>&1); }

  gate check >/dev/null && ok "計画段階(未承認・タスク未着手)は通る" || ng "計画段階で落ちた"
  sed -i.bak 's/- \[ \] 1.1/- [x] 1.1/' "$C/tasks.md" && rm -f "$C/tasks.md.bak"
  gate check >/dev/null && ng "未承認のタスク進行を通した" || ok "未承認のままタスク進行 → ブロック"
  mkdir -p "$g/tests/oracle/demo"; echo 'test("O1")' > "$g/tests/oracle/demo/dedup.test.ts"
  gate seal demo >/dev/null && ng "未承認で seal できた" || ok "未承認の seal を拒否"
  sed -i.bak 's/^approved_by: ""  /approved_by: "tester"/' "$C/quality.md" && rm -f "$C/quality.md.bak"
  gate seal demo >/dev/null && gate check >/dev/null && ok "承認 → seal → check が通る" || ng "seal 後の check が落ちた"
  sed -i.bak -e 's/- \[ \] 1.2/- [x] 1.2/' -e 's/- \[ \] 2.1/- [x] 2.1/' "$C/tasks.md" && rm -f "$C/tasks.md.bak"
  echo '// assertion removed' >> "$g/tests/oracle/demo/dedup.test.ts"
  gate check >/dev/null && ng "Oracle 改変を見逃した" || ok "seal 後の Oracle 改変 → ブロック"
  sed -i.bak '$d' "$g/tests/oracle/demo/dedup.test.ts" && rm -f "$g/tests/oracle/demo/dedup.test.ts.bak"
  gate check >/dev/null && ok "元に戻すと通る" || ng "復元後も落ちる"

  commit_all "$g" wip; base="$(git -C "$g" rev-parse HEAD)"
  A="$g/openspec/changes/archive/2026-01-01-demo"; cp -r "$C" "$A"; commit_all "$g" archive
  gate check --base "$base" >/dev/null && ng "evidence.md なしのアーカイブを通した" || ok "evidence.md なしのアーカイブ → ブロック"
  printf '# Evidence\n| R1 | F1 | O1 | dedup.test.ts | pass |\n' > "$A/evidence.md"
  gate check --base "$base" >/dev/null && ok "全 Risk ID の証跡があれば通る" || ng "証跡があるのに落ちた"
else
  skip "openspec CLI が無いため qe-gate の検証を省略"
fi

# ---------------------------------------------------------------------------
echo
echo "結果: pass $pass / fail $fail / skip $skipped"
[[ $fail -eq 0 ]]
