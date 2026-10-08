const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BEGIN, END, CURSOR_HEADER, TARGETS, renderTemplate, updateManagedRegion, validateProjectRoot, planSync, applyPlan, SyncQueue } = require(path.join(process.env.AI_CONTEXT_SYNC_TEST_OUTPUT, 'sync.cjs'));
const options = { source: 'context.md', header: 'Generated context' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-sync-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function sync(root, targets, content = 'Use named exports.', extra = {}) {
  return applyPlan(planSync([root], targets, content, { ...options, ...extra }));
}

test('preserves exact manual prefix and suffix through repeated managed updates', t => {
  const root = fixture(t), file = path.join(root, 'CLAUDE.md');
  const prefix = '# Manual instructions\r\nKeep this exact text.  ';
  fs.writeFileSync(file, prefix);
  assert.equal(sync(root, ['claude'], 'First context'), 1);
  const first = fs.readFileSync(file, 'utf8');
  assert.ok(first.startsWith(prefix + '\n\n' + BEGIN));
  fs.appendFileSync(file, '\n# Manual suffix\r\nKeep this too.');
  const before = fs.readFileSync(file, 'utf8');
  const suffix = before.slice(before.indexOf(END) + END.length);
  assert.equal(sync(root, ['claude'], 'Updated context'), 1);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after.slice(0, after.indexOf(BEGIN)), before.slice(0, before.indexOf(BEGIN)));
  assert.equal(after.slice(after.indexOf(END) + END.length), suffix);
  assert.ok(after.includes('Updated context'));
  assert.equal(sync(root, ['claude'], 'Updated context'), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('template substitutions are literal, global, and never rescan source content', t => {
  assert.equal(renderTemplate('{{CONTENT}} {{CONTENT}}', { CONTENT: '$& {{SOURCE}}' }), '$& {{SOURCE}} $& {{SOURCE}}');
  const root = fixture(t);
  const content = '$& $$ $` $\' {{SOURCE}} {{TIMESTAMP}} {{HEADER}} {{CONTENT}}';
  sync(root, ['agents'], content, { header: 'Note {{SOURCE}} {{SOURCE}} at {{TIMESTAMP}}', timestamp: 'TEST-TIME' });
  const result = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(result.includes('Note context.md context.md at TEST-TIME'));
  assert.ok(result.includes(content));
});

test('rejects malformed, duplicate, embedded, and source-owned markers without writes', t => {
  const root = fixture(t), file = path.join(root, 'CLAUDE.md');
  for (const original of [BEGIN, END, `${END}\n${BEGIN}`, `${BEGIN}\na\n${BEGIN}\nb\n${END}`, `prefix ${BEGIN}\na\n${END}`, `${BEGIN}\na\n${END} suffix`]) {
    fs.writeFileSync(file, original);
    assert.throws(() => sync(root, ['claude']));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  assert.throws(() => updateManagedRegion(null, `Literal ${BEGIN}`), /reserved/);
});

test('requires explicit existing absolute project directories and known targets', t => {
  const root = fixture(t), missing = path.join(root, 'typo');
  for (const roots of [[], ['relative/project'], [missing], [path.join(root, 'file')]]) {
    fs.writeFileSync(path.join(root, 'file'), 'not a directory');
    assert.throws(() => planSync(roots, ['claude'], 'context', options));
  }
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => planSync([root], [], 'context', options), /Enable/);
  assert.throws(() => planSync([root], ['unknown'], 'context', options), /Unsupported/);
  assert.equal(validateProjectRoot(root), fs.realpathSync(root));
});

test('preflights every destination and rejects linked files or parent escapes', t => {
  const root = fixture(t), outside = fixture(t);
  fs.writeFileSync(path.join(outside, 'private.md'), 'Do not change');
  fs.symlinkSync(path.join(outside, 'private.md'), path.join(root, 'AGENTS.md'));
  assert.throws(() => sync(root, ['claude', 'agents']), /symlink/);
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'private.md'), 'utf8'), 'Do not change');
  fs.symlinkSync(outside, path.join(root, '.github'), 'dir');
  assert.throws(() => sync(root, ['copilot']), /parent/);
  assert.equal(fs.existsSync(path.join(outside, 'copilot-instructions.md')), false);
});

test('rejects internal aliases, hard links, duplicate targets, and duplicate physical project roots', t => {
  const root = fixture(t), aliases = fixture(t);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Manual');
  fs.symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
  assert.throws(() => sync(root, ['claude', 'agents']), /symlink/);
  fs.unlinkSync(path.join(root, 'AGENTS.md'));
  fs.linkSync(path.join(root, 'CLAUDE.md'), path.join(root, 'AGENTS.md'));
  assert.throws(() => sync(root, ['claude', 'agents']), /hard-linked/);
  fs.unlinkSync(path.join(root, 'AGENTS.md'));
  assert.throws(() => sync(root, ['claude', 'claude']), /Duplicate/);
  const alias = path.join(aliases, 'alias'); fs.symlinkSync(root, alias, 'dir');
  assert.throws(() => planSync([root, alias], ['claude'], 'context', options), /Duplicate/);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'Manual');
});

test('refuses to write when any file changes after planning and leaves earlier files alone', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Original Claude');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Original Agents');
  const plan = planSync([root], ['claude', 'agents'], 'context', options);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'New manual edit');
  assert.throws(() => applyPlan(plan), /changed after preview/);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'Original Claude');
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'New manual edit');
});

test('rejects source/destination overlap and linked paths introduced after planning', t => {
  const root = fixture(t), outside = fixture(t), source = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(source, 'Source note');
  assert.throws(() => sync(root, ['claude'], 'context', { sourceAbsolutePath: source }), /also the source/);
  const plan = planSync([root], ['copilot'], 'context', options);
  fs.symlinkSync(outside, path.join(root, '.github'), 'dir');
  assert.throws(() => applyPlan(plan), /parent/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test('creates valid dedicated Cursor frontmatter and refuses an unowned existing rule', t => {
  const root = fixture(t), file = path.join(root, '.cursor/rules/ai-context-sync.mdc');
  sync(root, ['cursor-rules'], 'Follow these conventions.');
  const generated = fs.readFileSync(file, 'utf8');
  assert.ok(generated.startsWith(CURSOR_HEADER + BEGIN));
  assert.ok(generated.includes('alwaysApply: true\n---\n'));
  assert.equal(generated.includes('globs:'), false);
  assert.equal(sync(root, ['cursor-rules'], 'Follow these conventions.'), 0);
  fs.writeFileSync(file, '---\nalwaysApply: true\n---\nManual rule');
  assert.throws(() => sync(root, ['cursor-rules']), /already exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), '---\nalwaysApply: true\n---\nManual rule');
});

test('writes all supported targets and preserves existing file modes without leftover temp files', t => {
  const root = fixture(t), file = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(file, 'Manual', { mode: 0o640 });
  assert.equal(sync(root, TARGETS.map(target => target.id)), 4);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(root, 'AGENTS.md')).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.ai-context-sync-')), false);
});

test('queue serializes delayed reads and continues after failures', async () => {
  const queue = new SyncQueue(), order = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = queue.enqueue(async () => { order.push('read old'); await pending; order.push('write old'); });
  const second = queue.enqueue(async () => { order.push('read new'); order.push('write new'); });
  await Promise.resolve();
  assert.deepEqual(order, ['read old']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(order, ['read old', 'write old', 'read new', 'write new']);
  await assert.rejects(queue.enqueue(async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await queue.enqueue(async () => 'recovered'), 'recovered');
});


test('rejects invalid UTF-8 without changing the original bytes', t => {
  const root = fixture(t), file = path.join(root, 'CLAUDE.md');
  const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe]);
  fs.writeFileSync(file, bytes);
  assert.throws(() => sync(root, ['claude']), /UTF-8/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('refuses a project root replaced by a symlink after planning', t => {
  const parent = fixture(t), outside = fixture(t), root = path.join(parent, 'project');
  fs.mkdirSync(root);
  const plan = planSync([root], ['claude'], 'context', options);
  fs.rmdirSync(root); fs.symlinkSync(outside, root, 'dir');
  assert.throws(() => applyPlan(plan), /root changed/);
  assert.deepEqual(fs.readdirSync(outside), []);
});


test('an empty header preserves leading source whitespace literally', t => {
  const root = fixture(t), content = '\n\n  Indented content\n';
  sync(root, ['claude'], content, { header: '' });
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), `${BEGIN}\n${content}\n${END}\n`);
});
