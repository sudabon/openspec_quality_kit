#!/usr/bin/env node
// openspec-quality-kit installer.
// Node 標準ライブラリのみで実装する(外部依存を持たせない)。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = join(HERE, 'payload');
const STAMP_FILE = '.openspec-quality-kit.json';
const SCHEMA_NAME = 'quality-driven';

// openspec init が書く既定値。これだけは自動で quality-driven に切り替える。
// 進行中の change は .openspec.yaml に自分のスキーマを記録しているので影響を受けない。
const REPLACEABLE_SCHEMAS = new Set(['spec-driven']);

// プロジェクトごとに編集する前提のファイル(payload 相対)。
// 無ければ作成し、あれば内容に関わらず触らない(--force でも上書きしない)。
const SEED_FILES = new Set(['openspec/quality-policy.md']);

const USAGE = `usage: openspec-quality-kit [install|update] [--force] [--dry-run] [--target <dir>] [--language <lang>]

  install            payload を対象リポジトリへ導入する(既定)
  update             install と同じ処理。出力の文言が「更新」になる
  --target <dir>     対象ディレクトリ(既定: カレントディレクトリ)
  --language <lang>  openspec/config.yaml を新規作成するとき、artifact の言語を指定する
                     (openspec init --language と同じ context を書く。例: Japanese)
  --force            差分のあるファイルを上書きし、git リポジトリ確認をスキップする
                     (quality-policy.md は上書きしない)
  --dry-run          一切書き込まず、実行予定の操作だけを表示する
  -h, --help         このヘルプを表示する`;

// ---------------------------------------------------------------- args

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { command: null, target: null, force: false, dryRun: false, help: false, language: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'install' || a === 'update') {
      if (opts.command) throw new UsageError(`サブコマンドが重複しています: ${a}`);
      opts.command = a;
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--target' || a.startsWith('--target=')) {
      const v = a.includes('=') ? a.slice('--target='.length) : argv[++i];
      if (!v) throw new UsageError('--target には値が必要です');
      opts.target = v;
    } else if (a === '--language' || a.startsWith('--language=')) {
      const v = a.includes('=') ? a.slice('--language='.length) : argv[++i];
      if (!v || !v.trim()) throw new UsageError('--language には値が必要です');
      opts.language = v.trim();
    } else {
      throw new UsageError(`不明な引数: ${a}`);
    }
  }
  opts.command ??= 'install';
  opts.target = resolve(opts.target ?? process.cwd());
  return opts;
}

// ---------------------------------------------------------------- fs helpers

function walkFiles(root, base = root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join('/'));
  }
  return out.sort();
}

function isInsideGitRepo(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function applyExecBit(src, dest) {
  try {
    const mode = statSync(src).mode;
    if (mode & 0o111) chmodSync(dest, mode & 0o777);
  } catch {
    /* 実行ビットの引き継ぎに失敗しても致命的ではない */
  }
}

// ---------------------------------------------------------------- unified diff

function unifiedDiff(oldText, newText, oldLabel, newLabel, context = 3) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push(['-', a[i++]]); }
    else { ops.push(['+', b[j++]]); }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);

  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op[0] === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });

  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let printedGap = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep[idx]) { if (!printedGap) { lines.push('@@'); printedGap = true; } continue; }
    printedGap = false;
    lines.push(ops[idx][0] + ops[idx][1]);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- config.yaml merge

function findTopLevelKey(lines, key) {
  const re = new RegExp(`^${key}:(\\s*)(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) return { index: i, value: m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim() };
  }
  return null;
}

/** openspec init --language が書くものと同じ context */
function languageContext(lang) {
  return [
    'context: |',
    `  Language: ${lang}`,
    `  All artifacts must be written in ${lang}.`,
    '  Keep OpenSpec structural headings and SHALL/MUST keywords in English.',
  ];
}

/**
 * config.yaml を冪等にマージする。context には触らない
 * (他の kit のマーカーブロックと衝突させないため。品質ルールはスキーマの instruction が持つ)。
 * @returns {{text: string|null, notes: string[], warnings: string[]}} text=null は変更なし
 */
function mergeConfig(original, language) {
  const notes = [];
  const warnings = [];

  if (original === null) {
    const lines = [`schema: ${SCHEMA_NAME}`, ''];
    if (language) lines.push(...languageContext(language), '');
    notes.push(`openspec/config.yaml を新規作成 (schema: ${SCHEMA_NAME}${language ? `, language: ${language}` : ''})`);
    return { text: lines.join('\n'), notes, warnings };
  }

  const lines = original.split('\n');

  const schemaKey = findTopLevelKey(lines, 'schema');
  if (!schemaKey) {
    lines.unshift(`schema: ${SCHEMA_NAME}`);
    notes.push(`schema: ${SCHEMA_NAME} を追加`);
  } else if (REPLACEABLE_SCHEMAS.has(schemaKey.value)) {
    lines[schemaKey.index] = `schema: ${SCHEMA_NAME}`;
    notes.push(`schema: ${schemaKey.value} → ${SCHEMA_NAME}(進行中の change は各自の .openspec.yaml のスキーマのまま)`);
  } else if (schemaKey.value !== SCHEMA_NAME) {
    warnings.push(
      `openspec/config.yaml の schema が '${schemaKey.value}' です。'${SCHEMA_NAME}' へは自動変更しません。\n` +
      `  既定にする場合は手動で変更してください。change 単位なら: openspec new change <name> --schema ${SCHEMA_NAME}`
    );
  }

  if (language && !/^\s+Language:/m.test(original)) {
    warnings.push(
      `openspec/config.yaml が既にあるため --language は反映しません(openspec init と同じ扱い)。\n` +
      `  context に以下を手動で追加してください:\n    ${languageContext(language).slice(1).map(l => l.trim()).join('\n    ')}`
    );
  }

  const text = lines.join('\n');
  return { text: text === original ? null : text, notes, warnings };
}

// ---------------------------------------------------------------- main

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }

  const verb = opts.command === 'update' ? '更新' : '導入';
  const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
  console.log(`openspec-quality-kit v${version} — ${verb}先: ${opts.target}${opts.dryRun ? ' (dry-run)' : ''}`);

  // 1. git リポジトリ確認
  if (!isInsideGitRepo(opts.target)) {
    console.log(`\n⚠ ${opts.target} は git リポジトリではありません。`);
    if (opts.dryRun) {
      console.log('  (dry-run のため確認をスキップします)');
    } else if (opts.force) {
      console.log('  --force が指定されているため続行します。');
    } else if (process.stdin.isTTY) {
      if (!await confirm(`  このまま${verb}しますか?`)) { console.log('中止しました。'); return 0; }
    } else {
      console.error('  対話できない環境です。続行するには --force を指定してください。');
      return 1;
    }
  }

  const initialized = existsSync(join(opts.target, 'openspec', 'specs'));
  const planned = [];
  const created = [];
  const overwritten = [];
  const skipped = [];
  const kept = [];
  const warnings = [];

  // 2. payload の再帰コピー
  for (const rel of walkFiles(PAYLOAD)) {
    const src = join(PAYLOAD, rel);
    const content = readFileSync(src);
    const dest = join(opts.target, rel);

    if (!existsSync(dest)) {
      planned.push(`create  ${rel}`);
      created.push(rel);
      if (!opts.dryRun) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        applyExecBit(src, dest);
      }
      continue;
    }

    const existing = readFileSync(dest);
    if (existing.equals(content)) continue; // 同一内容 → サイレント skip

    if (SEED_FILES.has(rel)) {
      kept.push(rel); // プロジェクト側で編集されたポリシーは尊重する
      continue;
    }

    if (opts.force) {
      planned.push(`overwrite ${rel}`);
      overwritten.push(rel);
      if (!opts.dryRun) { writeFileSync(dest, content); applyExecBit(src, dest); }
    } else {
      planned.push(`skip(差分あり) ${rel}`);
      skipped.push(rel);
      console.log(`\n差分あり(上書きしません): ${rel}`);
      console.log(unifiedDiff(existing.toString('utf8'), content.toString('utf8'), `target/${rel}`, `payload/${rel}`));
    }
  }

  // 3. openspec/config.yaml のマージ
  const configPath = join(opts.target, 'openspec', 'config.yaml');
  const configBefore = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  const merged = mergeConfig(configBefore, opts.language);
  warnings.push(...merged.warnings);
  if (merged.text !== null) {
    for (const n of merged.notes) planned.push(`config  ${n}`);
    if (!opts.dryRun) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, merged.text);
    }
  }

  // 4. インストールスタンプ(バージョンが変わったときだけ書く。no-op の update で git 差分を作らない)
  const stampPath = join(opts.target, STAMP_FILE);
  let stamp = null;
  try { stamp = JSON.parse(readFileSync(stampPath, 'utf8')); } catch { /* 無い・壊れている */ }
  if (stamp?.version !== version) {
    planned.push(`stamp   ${STAMP_FILE} (version ${version})`);
    if (!opts.dryRun) {
      writeFileSync(stampPath, JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2) + '\n');
    }
  }

  // 5. 結果表示
  if (opts.dryRun) {
    console.log('\n実行予定の操作(書き込みは行っていません):');
    if (planned.length === 0) console.log('  (なし)');
    for (const p of planned) console.log(`  ${p}`);
  } else {
    console.log(`\n作成: ${created.length} 件 / 上書き: ${overwritten.length} 件 / 差分により skip: ${skipped.length} 件`);
    for (const n of merged.notes) console.log(`  config.yaml: ${n}`);
    if (!created.length && !overwritten.length && !merged.notes.length && stamp?.version === version) {
      console.log('  変更はありません(既に最新です)。');
    }
  }
  for (const f of kept) console.log(`  保持: ${f}(プロジェクト側で編集済みのため更新しません)`);

  if (skipped.length) {
    console.log('\n以下のファイルは対象側の内容が異なるため skip しました(上書きするには --force):');
    for (const f of skipped) console.log(`  - ${f}`);
  }
  for (const w of warnings) console.log(`\n⚠ ${w}`);

  // 6. 次の一手
  console.log('\n次のステップ:');
  if (!initialized) {
    console.log('  1. openspec init --tools <tool>   # 例: --tools claude');
    console.log('     ※ config.yaml が既にあるため、openspec init に --language を付けるとエラーになります。');
    console.log('       言語はこの kit の --language で指定してください。');
    console.log(`  2. openspec schema validate ${SCHEMA_NAME}`);
  } else {
    console.log(`  1. openspec schema validate ${SCHEMA_NAME}`);
  }
  console.log('  - openspec/quality-policy.md の Risk Level 定義をプロジェクトに合わせて編集');
  console.log('  - CI: README の reusable workflow スタブを .github/workflows/ に配置');
  console.log('  - .github/CODEOWNERS.example を参考に CODEOWNERS とブランチ保護を設定');

  console.log(opts.dryRun ? `\ndry-run 完了。書き込みは行っていません。` : `\n${verb}が完了しました。`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`エラー: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`エラー: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}
