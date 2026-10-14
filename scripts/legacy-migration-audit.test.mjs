import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditLegacyMigration, auditLegacyDatabase, readLegacyMigrationSnapshot, createMigrationReviewCandidate, migrationReceiptSha256 } from './legacy-migration-audit.mjs';

const LEGACY = 'restrict-with-stripe', NATIVE = 'paid-access';
const setting = (plugin, key, value) => ({ plugin, key, value: JSON.stringify(value) });
const rule = (plugin, collection = 'restrictions', data = {}) => ({ plugin, collection, id: collection === 'restrictions' ? 'posts:item' : 'tags:term', data: JSON.stringify({ ...(collection === 'restrictions' ? { collectionSlug: 'posts', contentId: 'item' } : { taxonomyName: 'tags', termId: 'term' }), requiredPlanSlugs: ['default-product'], ...(plugin === NATIVE ? { policy: 'members-only' } : {}), ...data }) });
const snapshot = () => ({ complete: true, storage: [rule(LEGACY), rule(NATIVE)], contentMetadata: [], settings: [setting(LEGACY, 'plan_mappings', { 'default-product': 'prod_fixture' }), setting(LEGACY, 'stripe_account_id', 'acct_fixture'), setting(LEGACY, 'stripe_environment', 'test'), setting(NATIVE, 'humansMode', 'stripe'), setting(NATIVE, 'stripeAccountId', 'acct_fixture'), setting(NATIVE, 'stripeEnvironment', 'test'), setting(NATIVE, 'humansPlans', [{ slug: 'default-product', name: 'Fixture', stripeProductId: 'prod_fixture', grantsVisibility: [] }]), { plugin: NATIVE, key: 'stripeSecretKey', present: true }] });
const codes = report => report.blockers.map(row => row.code);

test('fresh native site without legacy records has no migration requirement', () => {
 assert.equal(auditLegacyMigration({ complete: true, storage: [], settings: [], contentMetadata: [] }).safeToReplaceLegacy, true);
});
test('exact native selector/product/account/environment parity preserves only member-only rules', () => {
 const result = auditLegacyMigration(snapshot());
 assert.equal(result.safeToReplaceLegacy, false);
 assert.deepEqual(codes(result), ['legacy_migration_review_required']);
 assert.equal(result.counts.preservedRules, 1);
 for (const policy of ['public', 'agents-pay', 'members']) {
  const s = snapshot(); s.storage[1] = rule(NATIVE, 'restrictions', { policy });
  assert.ok(codes(auditLegacyMigration(s)).includes('changed_native_rule'));
 }
});
test('camel-case legacy taxonomy namespace compares with native snake-case namespace', () => {
 const s = snapshot(); s.storage = [rule(LEGACY, 'taxonomyRestrictions'), rule(NATIVE, 'taxonomy_restrictions')];
 assert.deepEqual(codes(auditLegacyMigration(s)), ['legacy_migration_review_required']);
 s.storage.pop(); assert.ok(codes(auditLegacyMigration(s)).includes('missing_native_rule'));
});
test('missing rules, broadened products, unresolved mappings and native delegation fail closed', () => {
 const variants = [s => s.storage.pop(), s => s.storage[1] = rule(NATIVE, 'restrictions', { productIds: ['prod_other'] }), s => s.settings[0] = setting(LEGACY, 'plan_mappings', {}), s => s.settings[3] = setting(NATIVE, 'humansMode', 'delegate'), s => s.settings[4] = setting(NATIVE, 'stripeAccountId', 'acct_different')];
 for (const change of variants) { const s = snapshot(); change(s); assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false); }
});
test('free-member rules and unknown legacy rule properties are never guessed', () => {
 for (const data of [{ requiredPlanSlugs: ['free'] }, { visibility: 'members' }, { requiredPlanSlugs: ['future-plan'] }, { productIds: 'prod_fixture' }]) {
  const s = snapshot(); s.storage[0] = rule(LEGACY, 'restrictions', data);
  assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 }
});
test('unknown collections, settings, invalid JSON and mismatched lookup keys block', () => {
 for (const mutate of [s => s.storage.push({ plugin: LEGACY, collection: 'future_rules' }), s => s.settings.push(setting(LEGACY, 'unknown', 'private')), s => s.storage[0].data = '{broken', s => s.storage[0].id = 'posts:other', s => s.storage.push(s.storage[0])]) {
  const s = snapshot(); mutate(s); assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 }
});
test('slug-keyed rules require matching actual lookup key and content identity', () => {
 const s = snapshot(); s.storage = [rule(LEGACY, 'restrictions', { slug: 'old-slug' }), rule(NATIVE, 'restrictions', { slug: 'old-slug' })];
 s.storage.forEach(r => r.id = 'posts:old-slug');
 assert.deepEqual(codes(auditLegacyMigration(s)), ['legacy_migration_review_required']);
 s.storage[1] = rule(NATIVE, 'restrictions', { contentId: 'other', slug: 'old-slug' }); s.storage[1].id = 'posts:old-slug';
 assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
});
test('content visibility and imported plan metadata always require separate migration review', () => {
 for (const row of [{ visibility: 'members' }, { visibility: 'paid' }, { visibility: 'future' }, { ghost_product_slugs: '["free"]' }, { ghost_product_slugs: '["default-product"]' }, { unsupported: true }]) {
  const s = snapshot(); s.contentMetadata.push(row); assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 }
 const s = snapshot(); s.contentMetadata.push({ visibility: 'public', ghost_product_slugs: '[]' }); assert.deepEqual(codes(auditLegacyMigration(s)), ['legacy_migration_review_required']);
});
test('privacy records count without parsing or emitting identities, secrets or content', () => {
 const s = snapshot(); const secret = 'EMAIL_AND_TOKEN_AND_CONTENT_MUST_NEVER_APPEAR';
 for (const collection of ['customers', 'sessions', 'authTokens']) s.storage.push({ plugin: LEGACY, collection, id: secret, data: secret });
 s.settings.push(setting(LEGACY, 'stripe_secret_key', secret));
 s.storage[0] = rule(LEGACY, 'restrictions', { title: secret });
 const result = auditLegacyMigration(s);
 assert.deepEqual(codes(result), ['legacy_migration_review_required']);
 assert.equal(result.counts.legacyCustomers, 1); assert.equal(result.counts.legacySessions, 1); assert.equal(result.counts.legacyAuthTokens, 1); assert.equal(result.counts.legacyCredentialSettings, 1);
 assert.equal(JSON.stringify(result).includes(secret), false);
});
test('incomplete snapshots and inaccessible schemas return only a generic blocker', () => {
 for (const value of [null, {}, { ...snapshot(), complete: false }]) assert.deepEqual(codes(auditLegacyMigration(value)), ['incomplete_snapshot']);
 assert.deepEqual(codes(auditLegacyDatabase({ prepare() { throw new Error('secret sql'); } })), ['incomplete_snapshot']);
});

function database(path = ':memory:') {
 const db = new DatabaseSync(path);
 db.exec('CREATE TABLE _plugin_storage(plugin_id TEXT, collection TEXT, id TEXT, data TEXT); CREATE TABLE options(name TEXT, value TEXT); CREATE TABLE ec_posts(id TEXT, visibility TEXT, ghost_product_slugs TEXT, content TEXT); CREATE TABLE revisions(collection TEXT, entry_id TEXT, data TEXT)');
 const s = snapshot();
 for (const row of s.storage) db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(row.plugin, row.collection, row.id, row.data);
 for (const row of s.settings) db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${row.plugin}:${row.plugin === NATIVE ? 'settings:' : ''}${row.key}`, row.key === 'stripeSecretKey' ? '"SYNTHETIC_ONLY"' : row.value);
 return db;
}
test('SQLite reader issues SELECT only and never selects secret/session/body values', () => {
 const db = database(); const secret = 'PRIVATE_FIXTURE';
 db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_secret_key`, secret);
 db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(LEGACY, 'sessions', secret, secret);
 db.prepare('INSERT INTO ec_posts VALUES(?,?,?,?)').run('item', 'public', '[]', secret);
 const calls = []; const wrapper = { prepare(sql) { assert.match(sql, /^SELECT /); calls.push(sql); return db.prepare(sql); } };
 const collected = readLegacyMigrationSnapshot(wrapper);
 assert.equal(JSON.stringify(collected).includes(secret), false);
 assert.deepEqual(codes(auditLegacyDatabase(wrapper)), ['legacy_migration_review_required']);
 assert.ok(calls.length > 3); db.close();
});
test('SQLite includes legacy camel taxonomy, unknown KV namespace, content and historical revisions', () => {
 for (const insert of [db => db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(LEGACY, 'taxonomyRestrictions', 'tags:term', rule(LEGACY, 'taxonomyRestrictions').data), db => db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(LEGACY, '__kv', 'mystery', 'private'), db => db.prepare('INSERT INTO ec_posts VALUES(?,?,?,?)').run('item', 'paid', '[]', 'private'), db => db.prepare('INSERT INTO revisions VALUES(?,?,?)').run('posts', 'item', JSON.stringify({ visibility: 'members', content: 'private' }))]) {
  const db = database(); insert(db); assert.equal(auditLegacyDatabase(db).safeToReplaceLegacy, false); db.close();
 }
});
test('offline file audit preserves database bytes and refuses live-like CLI arguments', () => {
 const directory = mkdtempSync(join(tmpdir(), 'paid-migration-audit-'));
 try {
  const path = join(directory, 'offline.db'); database(path).close();
  const before = readFileSync(path); const db = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(codes(auditLegacyDatabase(db)), ['legacy_migration_review_required']); db.close();
  assert.deepEqual(readFileSync(path), before);
  for (const args of [[], ['--database', path], ['--offline-database', 'relative.db']]) {
   const result = spawnSync(process.execPath, [new URL('./legacy-migration-audit.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
   assert.equal(result.status, 2); assert.equal(result.stdout, '');
  }
  writeFileSync(`${path}-wal`, 'active');
  const result = spawnSync(process.execPath, [new URL('./legacy-migration-audit.mjs', import.meta.url).pathname, '--offline-database', path]);
  assert.equal(result.status, 2); assert.deepEqual(readFileSync(path), before);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

const nativeSnapshot = () => {
 const s = snapshot(); s.storage = s.storage.filter(row => row.plugin === NATIVE); s.settings = s.settings.filter(row => row.plugin === NATIVE);
 s.settings.find(row => row.key === 'humansPlans').value = JSON.stringify([{ slug: 'default-product', name: 'Paid', stripeProductId: 'prod_fixture', grantsVisibility: ['members', 'paid'] }, { slug: 'content-personall-ai', name: 'Other', stripeProductId: 'prod_fixture', grantsVisibility: [] }]);
 return s;
};
test('native-only restart permits supported protected metadata with independent mapped plans', () => {
 for (const metadata of [{ visibility: 'members' }, { visibility: 'paid', ghost_product_slugs: '["default-product"]' }]) {
  const s = nativeSnapshot(); s.contentMetadata.push({ collection: 'posts', id: 'item', slug: 'entry-slug', ...metadata });
  const result = auditLegacyMigration(s);
  assert.equal(result.counts.legacyArtifacts, 0); assert.equal(result.safeToReplaceLegacy, true);
 }
});
test('native-only exemption rejects unknown, free, unmapped and unconfigured semantics', () => {
 for (const mutate of [s => s.contentMetadata.push({ visibility: 'free' }), s => s.contentMetadata.push({ visibility: 'future' }), s => s.contentMetadata.push({ ghost_product_slugs: '["missing"]' }), s => { s.contentMetadata.push({ visibility: 'paid' }); s.settings = s.settings.filter(row => row.key !== 'stripeSecretKey'); }, s => { s.contentMetadata.push({ visibility: 'paid' }); s.settings.find(row => row.key === 'humansMode').value = '"delegate"'; }]) {
  const s = nativeSnapshot(); mutate(s); assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 }
});
test('native SQLite configuration signals credential existence without reading its value', () => {
 const db = database(); db.prepare('DELETE FROM _plugin_storage WHERE plugin_id=?').run(LEGACY); db.prepare("DELETE FROM options WHERE name LIKE 'plugin:restrict-with-stripe:%'").run();
 db.prepare('UPDATE options SET value=? WHERE name=?').run('"NEVER_READ_SECRET"', 'plugin:paid-access:settings:stripeSecretKey');
 const collected = readLegacyMigrationSnapshot(db);
 assert.equal(JSON.stringify(collected).includes('NEVER_READ_SECRET'), false);
 assert.equal(auditLegacyDatabase(db).counts.nativeCredentialSettings, 1);
 db.close();
});

test('CLI invoked through a symlink still validates arguments instead of silently doing nothing', () => {
 const directory = mkdtempSync(join(tmpdir(), 'paid-audit-alias-'));
 try {
  const alias = join(directory, 'alias.mjs');
  symlinkSync(new URL('./legacy-migration-audit.mjs', import.meta.url).pathname, alias);
  const result = spawnSync(process.execPath, [alias], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /Offline migration audit refused/);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('external changes detected by SQLite data_version invalidate the entire audit', () => {
 const db = database(); let calls = 0;
 const wrapper = { prepare(sql) { if (sql === 'SELECT data_version FROM pragma_data_version') return { all() { return [{ data_version: ++calls }]; } }; return db.prepare(sql); } };
 assert.deepEqual(codes(auditLegacyDatabase(wrapper)), ['incomplete_snapshot']);
 db.close();
});

const receiptOptions = candidate => {
 const reviewedReceiptJson = `${JSON.stringify(candidate, null, 2)}\n`;
 return { reviewedReceiptJson, approvedReceiptSha256: migrationReceiptSha256(reviewedReceiptJson) };
};
test('reviewed receipt permits retained source data, preparation alone never approves', () => {
 const s = snapshot(); const before = JSON.stringify(s);
 const candidate = createMigrationReviewCandidate(s);
 assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 assert.equal(auditLegacyMigration(s, receiptOptions(candidate)).safeToReplaceLegacy, true);
 assert.equal(JSON.stringify(s), before);
 assert.equal(JSON.stringify(candidate).includes('prod_fixture'), false);
 assert.equal(JSON.stringify(candidate).includes('posts:item'), false);
 assert.equal(JSON.stringify(candidate).includes('acct_fixture'), false);
 for (const options of [{ reviewedReceipt: candidate }, { reviewedReceiptJson: JSON.stringify(candidate) }, { ...receiptOptions(candidate), reviewedReceiptJson: JSON.stringify(candidate) }]) assert.equal(auditLegacyMigration(s, options).safeToReplaceLegacy, false);
});
test('receipt rejects source, native protection, mapping, identity and taxonomy drift', () => {
 const s = snapshot(); s.contentMetadata.push({ collection: 'posts', id: 'item', slug: 'example', visibility: 'public' });
 const approved = receiptOptions(createMigrationReviewCandidate(s));
 const mutations = [
  s => s.settings.push(setting(LEGACY, 'show_excerpts', false)),
  s => s.storage[1] = rule(NATIVE, 'restrictions', { agentPrice: '1' }),
  s => s.storage[1] = rule(NATIVE, 'restrictions', { passEligible: true }),
  s => s.settings[0] = setting(LEGACY, 'plan_mappings', { 'default-product': 'prod_other' }),
  s => s.contentMetadata[0].slug = 'new-slug',
  s => s.contentMetadata[0].id = 'new-id',
  s => s.contentMetadata[0].visibility = 'paid',
  s => s.entryTerms = [{ collection: 'posts', entryId: 'item', taxonomyName: 'tags', termId: 'term' }],
  s => s.storage.push({ plugin: LEGACY, collection: 'sessions' }),
 ];
 for (const mutate of mutations) { const changed = structuredClone(s); mutate(changed); assert.equal(auditLegacyMigration(changed, approved).safeToReplaceLegacy, false); }
});
test('unrelated new native entries and plan presentation do not invalidate inherited review', () => {
 const s = snapshot(); const approved = receiptOptions(createMigrationReviewCandidate(s));
 s.storage.push({ ...rule(NATIVE, 'restrictions', { contentId: 'new' }), id: 'posts:new' });
 s.contentMetadata.push({ collection: 'posts', id: 'new', visibility: 'public' });
 const plans = JSON.parse(s.settings.find(row => row.key === 'humansPlans').value);
 plans[0].name = 'Renamed'; plans.push({ slug: 'unrelated', name: 'New plan', stripeProductId: 'prod_new', grantsVisibility: [] });
 s.settings.find(row => row.key === 'humansPlans').value = JSON.stringify(plans);
 assert.equal(auditLegacyMigration(s, approved).safeToReplaceLegacy, true);
});
test('substantive blockers cannot be waived by a prepared or manually rehashed receipt', () => {
 for (const mutate of [s => s.storage[0] = rule(LEGACY, 'restrictions', { requiredPlanSlugs: ['free'] }), s => s.storage.push({ plugin: LEGACY, collection: 'future' }), s => s.contentMetadata.push({ collection: 'posts', id: 'item', visibility: 'future' }), s => s.contentMetadata.push({ collection: 'posts', id: 'item', ghost_product_slugs: '["unknown"]' })]) {
  const s = snapshot(); const candidate = createMigrationReviewCandidate(s); mutate(s);
  assert.throws(() => createMigrationReviewCandidate(s));
  assert.equal(auditLegacyMigration(s, receiptOptions(candidate)).safeToReplaceLegacy, false);
 }
});
test('metadata requires row-ID rule for every locale, not grantsVisibility or group rules', () => {
 const s = nativeSnapshot(); s.contentMetadata = [{ collection: 'posts', id: 'item', visibility: 'paid' }];
 assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
 s.storage = []; assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 s.storage = [{ ...rule(NATIVE, 'restrictions', { contentId: 'group' }), id: 'posts:group' }];
 assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 s.storage = [rule(NATIVE)]; s.contentMetadata.push({ collection: 'posts', id: 'localized', visibility: 'paid' });
 assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 s.storage.push({ ...rule(NATIVE, 'restrictions', { contentId: 'localized' }), id: 'posts:localized' });
 assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
});
test('additional slug and assigned taxonomy grants cannot broaden protected row access', () => {
 for (const kind of ['slug', 'taxonomy']) {
  const s = nativeSnapshot(); s.contentMetadata = [{ collection: 'posts', id: 'item', slug: 'example', visibility: 'paid' }];
  if (kind === 'slug') s.storage.push({ ...rule(NATIVE, 'restrictions', { slug: 'example', requiredPlanSlugs: [], productIds: ['prod_other'] }), id: 'posts:example' });
  else { s.storage.push(rule(NATIVE, 'taxonomy_restrictions', { requiredPlanSlugs: [], productIds: ['prod_other'] })); s.entryTerms = [{ collection: 'posts', entryId: 'item', taxonomyName: 'tags', termId: 'term' }]; }
  assert.ok(codes(auditLegacyMigration(s)).includes('changed_native_rule'));
 }
});
test('SQLite taxonomy proof follows localized content through translation-group assignments', () => {
 const db = database();
 db.exec('ALTER TABLE ec_posts ADD COLUMN translation_group TEXT; CREATE TABLE content_taxonomies(collection TEXT,entry_id TEXT,taxonomy_id TEXT); CREATE TABLE taxonomies(id TEXT,name TEXT,translation_group TEXT)');
 db.prepare('INSERT INTO ec_posts(id,visibility,translation_group) VALUES(?,?,?)').run('item', 'public', 'entry-group');
 db.prepare('INSERT INTO content_taxonomies VALUES(?,?,?)').run('posts', 'entry-group', 'term-group');
 db.prepare('INSERT INTO taxonomies VALUES(?,?,?)').run('term-fr', 'tags', 'term-group');
 assert.deepEqual(readLegacyMigrationSnapshot(db).entryTerms.map(row => ({...row})), [{ collection: 'posts', entryId: 'item', taxonomyName: 'tags', termId: 'term-fr' }]);
 db.close();
});
test('native migration marker and pending modes require explicit offline resolution', () => {
 for (const pending of [true, 'true', null]) {
  const s = snapshot(); s.settings.push(setting(NATIVE, 'state:legacyPluginPresent', pending));
  assert.ok(codes(auditLegacyMigration(s)).includes('native_configuration'));
  assert.throws(() => createMigrationReviewCandidate(s));
 }
 for (const mode of ['delegate', 'migration-required']) {
  const s = nativeSnapshot(); s.settings.find(row => row.key === 'humansMode').value = JSON.stringify(mode);
  assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 }
 const db = database(); db.prepare('INSERT INTO options VALUES(?,?)').run('plugin:paid-access:state:legacyPluginPresent', 'true');
 assert.ok(codes(auditLegacyDatabase(db)).includes('native_configuration'));
 db.prepare('UPDATE options SET value=? WHERE name=?').run('false', 'plugin:paid-access:state:legacyPluginPresent');
 assert.deepEqual(codes(auditLegacyDatabase(db)), ['legacy_migration_review_required']);
 db.close();
});
test('SQLite receipt roundtrip retains source and rejects a restored metadata change', () => {
 const db = database(); db.prepare('INSERT INTO ec_posts VALUES(?,?,?,?)').run('item', 'public', '[]', 'PRIVATE_BODY');
 const before = db.prepare('SELECT COUNT(*) AS n FROM _plugin_storage WHERE plugin_id=?').get(LEGACY).n;
 const receipt = createMigrationReviewCandidate(readLegacyMigrationSnapshot(db));
 const options = receiptOptions(receipt);
 assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, true);
 db.prepare('INSERT INTO revisions VALUES(?,?,?)').run('posts', 'item', JSON.stringify({ visibility: 'paid', content: 'PRIVATE_BODY' }));
 assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _plugin_storage WHERE plugin_id=?').get(LEGACY).n, before);
 assert.equal(JSON.stringify(receipt).includes('PRIVATE_BODY'), false);
 db.close();
});
test('inherited metadata requires the original product and account, not merely a mapped replacement', () => {
 const s = snapshot(); s.storage = [rule(NATIVE)]; s.contentMetadata = [{ collection: 'posts', id: 'item', ghost_product_slugs: '["default-product"]' }];
 assert.deepEqual(codes(auditLegacyMigration(s)), ['legacy_migration_review_required']);
 s.settings[0] = setting(LEGACY, 'plan_mappings', { 'default-product': 'prod_original' });
 assert.ok(codes(auditLegacyMigration(s)).includes('unresolved_plan'));
 s.settings[1] = setting(LEGACY, 'stripe_account_id', 'acct_original');
 assert.ok(codes(auditLegacyMigration(s)).includes('native_configuration'));
});
test('historical free ghost classification alone is public without native credentials', () => {
 for (const visibility of [undefined, null, 'public']) {
  const s = { complete: true, storage: [], settings: [], contentMetadata: [{ collection: 'posts', id: 'public', visibility, ghost_product_slugs: '["free"]' }] };
  assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
  assert.equal(auditLegacyMigration(s).counts.nativeCredentialSettings, 0);
 }
});
test('free ghost classification preserves paid visibility and explicit paid slugs', () => {
 for (const visibility of ['members', 'paid']) {
  const s = nativeSnapshot();
  s.contentMetadata = [{ collection: 'posts', id: 'item', visibility, ghost_product_slugs: '["free"]' }];
  assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
  s.storage = []; assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 }
 for (const visibility of [null, undefined]) {
  const s = nativeSnapshot();
  s.contentMetadata = [{ collection: 'posts', id: 'item', visibility, ghost_product_slugs: '["free","default-product"]' }];
  assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
  s.storage = []; assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, false);
 }
});
test('free metadata normalization never excuses unknown metadata or explicit free access rules', () => {
 const s = nativeSnapshot();
 s.contentMetadata = [{ collection: 'posts', id: 'item', ghost_product_slugs: '["free","unknown"]' }];
 assert.ok(codes(auditLegacyMigration(s)).includes('unresolved_plan'));
 s.contentMetadata = [{ collection: 'posts', id: 'item', visibility: 'free', ghost_product_slugs: '["free"]' }];
 assert.ok(codes(auditLegacyMigration(s)).includes('free_member_semantics'));
 for (const plugin of [LEGACY, NATIVE]) {
  const restricted = snapshot(); restricted.storage = [rule(plugin, 'restrictions', { requiredPlanSlugs: ['free'] })];
  assert.ok(codes(auditLegacyMigration(restricted)).includes('free_member_semantics'));
 }
});
test('unused native catalog drafts permit absent, null and empty Stripe products', () => {
 for (const stripeProductId of [undefined, null, '']) {
  const s = { complete: true, storage: [], contentMetadata: [], settings: [setting(NATIVE, 'humansPlans', [{ slug: 'draft', name: 'Draft', grantsVisibility: [], stripeProductId }])] };
  assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
 }
 for (const stripeProductId of [false, 0, [], {}, ' ']) {
  const s = { complete: true, storage: [], contentMetadata: [], settings: [setting(NATIVE, 'humansPlans', [{ slug: 'draft', name: 'Draft', grantsVisibility: [], stripeProductId }])] };
  assert.ok(codes(auditLegacyMigration(s)).includes('native_configuration'));
 }
});
test('unlinked native products cannot satisfy inherited rules or protected metadata', () => {
 for (const stripeProductId of [undefined, null, '']) {
  for (const inherited of [true, false]) {
   const s = inherited ? snapshot() : nativeSnapshot();
   const plans = JSON.parse(s.settings.find(row => row.key === 'humansPlans').value);
   for (const plan of plans) plan.stripeProductId = stripeProductId;
   s.settings.find(row => row.key === 'humansPlans').value = JSON.stringify(plans);
   if (!inherited) { s.storage = []; s.contentMetadata = [{ collection: 'posts', id: 'item', visibility: 'paid' }]; }
   assert.ok(codes(auditLegacyMigration(s)).includes('unresolved_plan'));
  }
 }
});
test('explicit public metadata ignores known historical labels but refuses unknown labels', () => {
 for (const labels of [['default-product'], ['content-personall-ai'], ['free', 'default-product', 'content-personall-ai']]) {
  const s = { complete: true, storage: [], settings: [], contentMetadata: [{ collection: 'posts', id: 'public', visibility: 'public', ghost_product_slugs: JSON.stringify(labels) }] };
  assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
  s.contentMetadata[0].ghost_product_slugs = JSON.stringify([...labels, 'unknown']);
  assert.ok(codes(auditLegacyMigration(s)).includes('unresolved_plan'));
 }
});
test('public historical labels do not override an explicit inherited restriction', () => {
 const s = snapshot(); s.contentMetadata = [{ collection: 'posts', id: 'item', visibility: 'public', ghost_product_slugs: '["default-product"]' }];
 assert.deepEqual(codes(auditLegacyMigration(s)), ['legacy_migration_review_required']);
 s.storage = s.storage.filter(row => row.plugin === LEGACY);
 assert.ok(codes(auditLegacyMigration(s)).includes('missing_native_rule'));
});
test('native-only public rules cannot waive protected revisions with a prepared pinned receipt', () => {
 const s = snapshot();
 s.settings[0] = setting(LEGACY, 'plan_mappings', { 'default-product': 'prod_fixture', 'content-personall-ai': 'prod_fixture' });
 const plans = JSON.parse(s.settings.find(row => row.key === 'humansPlans').value);
 plans.push({ slug: 'content-personall-ai', name: 'Paid', stripeProductId: 'prod_fixture', grantsVisibility: [] });
 s.settings.find(row => row.key === 'humansPlans').value = JSON.stringify(plans);
 s.contentMetadata = [{ collection: 'posts', id: 'item', visibility: 'public' }, { collection: 'posts', id: 'item', revision: true, visibility: 'paid' }];
 // Prepare and independently pin while protection is intact. Neither the receipt
 // nor later removal of legacy records authorizes making a protected revision public.
 const approved = receiptOptions(createMigrationReviewCandidate(s));
 assert.equal(auditLegacyMigration(s, approved).safeToReplaceLegacy, true);
 s.storage = [rule(NATIVE, 'restrictions', { policy: 'public' })];
 s.settings = s.settings.filter(row => row.plugin === NATIVE);
 for (const mode of ['stripe', 'off']) {
  s.settings.find(row => row.key === 'humansMode').value = JSON.stringify(mode);
  for (const options of [undefined, approved]) {
   const report = auditLegacyMigration(s, options);
   assert.equal(report.counts.legacyArtifacts, 0);
   assert.equal(report.safeToReplaceLegacy, false);
   assert.ok(codes(report).includes('missing_native_rule'));
   if (mode === 'off') assert.ok(codes(report).includes('native_configuration'));
  }
 }
});
