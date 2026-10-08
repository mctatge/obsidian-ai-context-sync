const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const notices = [];
class TFile { constructor(file) { this.path = file; this.basename = path.basename(file, '.md'); } }
class FileSystemAdapter { constructor(root) { this.root = root; } getBasePath() { return this.root; } }
function element() { return { setText() {}, remove() {}, empty() {}, createEl: element }; }
class Plugin {
  async loadData() { return this.saved; }
  async saveData(value) { this.persisted = JSON.parse(JSON.stringify(value)); }
  registerEvent(event) { this.registered = event; }
  addCommand(command) { this.commands ??= []; this.commands.push(command); }
  addRibbonIcon() {} addSettingTab(tab) { this.tab = tab; }
  addStatusBarItem() { return element(); }
}
class Modal { constructor() { this.contentEl = element(); } open() { this.onOpen?.(); } close() {} }
class PluginSettingTab { constructor() { this.containerEl = element(); } }
const mock = { Plugin, TFile, FileSystemAdapter, Modal, PluginSettingTab, Notice: class { constructor(message) { notices.push(message); } }, Setting: class {} };
const originalLoad = Module._load;
Module._load = function(request, ...args) { return request === 'obsidian' ? mock : originalLoad.call(this, request, ...args); };
let PluginClass, normalizeSettings;
try { ({ default: PluginClass, normalizeSettings } = require(path.join(process.env.AI_CONTEXT_SYNC_TEST_OUTPUT, 'plugin.cjs'))); }
finally { Module._load = originalLoad; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, saved) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-sync-plugin-'));
  const vault = path.join(temp, 'vault'), project = path.join(temp, 'project');
  fs.mkdirSync(vault); fs.mkdirSync(project); fs.writeFileSync(path.join(vault, 'context.md'), 'Initial context');
  const source = new TFile('context.md'); let listener;
  const plugin = new PluginClass();
  plugin.saved = saved ?? { version: 2, sourceNotePath: source.path, projectPaths: [project], syncTargets: [{ id: 'claude', enabled: true }] };
  plugin.app = { vault: {
    adapter: new FileSystemAdapter(vault),
    on(event, callback) { assert.equal(event, 'modify'); listener = callback; return callback; },
    getAbstractFileByPath(file) { return file === source.path ? source : null; },
    async read(file) { return fs.readFileSync(path.join(vault, file.path), 'utf8'); },
  }};
  await plugin.onload();
  t.after(() => { plugin.onunload(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { plugin, vault, project, source, emit: () => listener(source), destination: path.join(project, 'CLAUDE.md') };
}

test('fresh settings are opt-in and migration removes arbitrary paths/templates and unsupported targets', () => {
  const fresh = normalizeSettings();
  assert.equal(fresh.autoSyncOnSave, false);
  assert.equal(fresh.syncTargets.some(target => target.enabled), false);
  const migrated = normalizeSettings({ autoSyncOnSave: true, syncTargets: [
    { id: 'codex', enabled: true, outputPath: '../escape', template: 'untrusted' },
    { id: 'gemini', enabled: true },
    { id: 'cursor-rules', enabled: true, outputPath: '.cursor/rules/ai-context.md' },
  ] });
  assert.equal(migrated.autoSyncOnSave, false);
  assert.equal(migrated.syncTargets.find(target => target.id === 'agents').enabled, true);
  assert.equal(migrated.syncTargets.some(target => 'outputPath' in target || target.id === 'gemini'), false);
});

test('actual bundled listener responds immediately to both toggle directions and cancels pending auto-sync', async t => {
  const f = await fixture(t);
  f.emit(); await delay(550);
  assert.equal(fs.existsSync(f.destination), false);
  await f.plugin.setAutoSync(true);
  f.emit(); await delay(650);
  assert.ok(fs.readFileSync(f.destination, 'utf8').includes('Initial context'));
  const original = fs.readFileSync(f.destination, 'utf8');
  fs.writeFileSync(path.join(f.vault, f.source.path), 'New context');
  f.emit(); await f.plugin.setAutoSync(false); await delay(650);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), original);
  f.emit(); await delay(550);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), original);
  await f.plugin.setAutoSync(true); f.emit(); await delay(650);
  assert.ok(fs.readFileSync(f.destination, 'utf8').includes('New context'));
});

test('bundled manual sync reads inside one queue so delayed old content cannot overwrite newer content', async t => {
  const f = await fixture(t);
  let release, reads = 0, active = 0, maximum = 0;
  const pending = new Promise(resolve => { release = resolve; });
  f.plugin.app.vault.read = async () => {
    reads++; active++; maximum = Math.max(maximum, active);
    const content = fs.readFileSync(path.join(f.vault, f.source.path), 'utf8');
    if (reads === 1) await pending;
    active--; return content;
  };
  const first = f.plugin.syncToAllTargets(); await Promise.resolve();
  fs.writeFileSync(path.join(f.vault, f.source.path), 'Newest context');
  const second = f.plugin.syncToAllTargets();
  assert.equal(reads, 1);
  release(); await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(reads, 2);
  const result = fs.readFileSync(f.destination, 'utf8');
  assert.ok(result.includes('Newest context'));
  assert.equal(result.includes('Initial context'), false);
});

test('turning off auto-sync during a delayed read suppresses its write', async t => {
  const f = await fixture(t);
  await f.plugin.setAutoSync(true);
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  f.plugin.app.vault.read = async () => { started(); await pending; return 'Do not write'; };
  const automatic = f.plugin.sync(undefined, true);
  await reading; await f.plugin.setAutoSync(false); release(); await automatic;
  assert.equal(fs.existsSync(f.destination), false);
});

test('unload cancels a pending timer and a queued sync', async t => {
  const f = await fixture(t);
  await f.plugin.setAutoSync(true); f.emit(); f.plugin.onunload(); await delay(650);
  await f.plugin.syncToAllTargets();
  assert.equal(fs.existsSync(f.destination), false);
});

test('settings changes during a delayed read abort before writes; invalid roots cannot enable auto-sync', async t => {
  const f = await fixture(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.plugin.app.vault.read = async () => { await pending; return 'Old settings'; };
  const syncing = f.plugin.syncToAllTargets(); await Promise.resolve();
  f.plugin.settings.projectPaths = [path.join(f.project, 'missing')];
  await f.plugin.saveSettings(); release(); await syncing;
  assert.equal(fs.existsSync(f.destination), false);
  await f.plugin.setAutoSync(true);
  assert.equal(f.plugin.settings.autoSyncOnSave, false);
  assert.equal(fs.existsSync(path.join(f.project, 'missing')), false);
  assert.ok(notices.some(notice => notice.includes('settings changed')));
});

test('preview validates destinations without writing to the disposable project', async t => {
  const f = await fixture(t);
  await f.plugin.previewSync();
  assert.deepEqual(fs.readdirSync(f.project), []);
});


test('an automatic sync queued before a configuration change is cancelled', async t => {
  const f = await fixture(t);
  await f.plugin.setAutoSync(true);
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  let reads = 0;
  f.plugin.app.vault.read = async () => { reads++; started(); await pending; return 'Old configuration'; };
  const manual = f.plugin.syncToAllTargets(); await reading;
  f.emit(); await delay(550);
  f.plugin.settings.customHeader = 'New header'; await f.plugin.saveSettings();
  release(); await manual;
  await f.plugin.queue.enqueue(async () => undefined);
  assert.equal(reads, 1);
  assert.equal(fs.existsSync(f.destination), false);
});
