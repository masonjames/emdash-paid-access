import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditLegacyMigration, auditLegacyDatabase, readLegacyMigrationSnapshot, readLegacyMigrationIdentitySource, readLegacyMigrationIdentityBinding, createMigrationReviewCandidate, migrationReceiptSha256 } from './legacy-migration-audit.mjs';

const LEGACY = 'restrict-with-stripe', NATIVE = 'paid-access';
const REGISTRY = 'plugin:paid-access:migration:customer-bindings:v1';
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
 assert.deepEqual(codes(result), ['legacy_migration_review_required', 'account_attestation_mismatch']);
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
test('empty plain-object labels normalize only with explicit public visibility', () => {
 for (const labels of [{}, Object.create(null), '{}']) {
  for (const revision of [false, true]) {
   const row = { collection: 'posts', id: 'item', revision, visibility: 'public', ghost_product_slugs: labels };
   const s = { complete: true, storage: [], settings: [], contentMetadata: [row] };
   assert.equal(auditLegacyMigration(s).safeToReplaceLegacy, true);
   assert.equal(row.ghost_product_slugs, labels);
   for (const visibility of ['members', 'paid', 'free', 'unknown', undefined, null]) {
    row.visibility = visibility;
    assert.ok(codes(auditLegacyMigration(s)).includes('invalid_record'));
   }
  }
 }
 for (const labels of [{ paid: true }, '{"paid":true}', new Date(0), new Map(), Object.create({}), Object.create(Date.prototype), Object.defineProperty({}, 'hidden', { value: true }), { [Symbol('label')]: true }]) {
  assert.ok(codes(auditLegacyMigration({ complete: true, storage: [], settings: [], contentMetadata: [{ visibility: 'public', ghost_product_slugs: labels }] })).includes('invalid_record'));
 }
});
test('public empty-object normalization preserves explicit legacy and native restrictions', () => {
 for (const labels of [{}, '{}']) {
  const s = snapshot();
  s.contentMetadata = [false, true].map(revision => ({ collection: 'posts', id: 'item', revision, visibility: 'public', ghost_product_slugs: labels }));
  const approved = receiptOptions(createMigrationReviewCandidate(s));
  assert.equal(auditLegacyMigration(s, approved).safeToReplaceLegacy, true);
  assert.equal(auditLegacyMigration(s).counts.preservedRules, 1);
  for (const change of [
   x => x.storage.pop(),
   x => x.storage[1] = rule(NATIVE, 'restrictions', { policy: 'public' }),
   x => x.storage[1] = rule(NATIVE, 'restrictions', { productIds: ['prod_other'] }),
   x => x.storage[0] = rule(LEGACY, 'restrictions', { requiredPlanSlugs: ['free'] }),
   x => x.storage = [rule(NATIVE, 'restrictions', { requiredPlanSlugs: ['free'] })],
   x => x.storage = [rule(NATIVE, 'restrictions', { requiredPlanSlugs: ['unknown'] })],
  ]) {
   const changed = structuredClone(s); change(changed);
   assert.equal(auditLegacyMigration(changed, approved).safeToReplaceLegacy, false);
   assert.throws(() => createMigrationReviewCandidate(changed));
  }
 }
});
test('SQLite current and retained empty-object metadata stay byte-identical and fail closed outside public', () => {
 const db = database();
 try {
  db.prepare('INSERT INTO ec_posts VALUES(?,?,?,?)').run('item', 'public', ' {} ', 'SYNTHETIC_BODY');
  const revision = '{ "visibility": "public", "ghost_product_slugs": {}, "content": "SYNTHETIC_BODY" }';
  db.prepare('INSERT INTO revisions VALUES(?,?,?)').run('posts', 'item', revision);
  const before = db.prepare('SELECT * FROM ec_posts').all();
  const approved = receiptOptions(createMigrationReviewCandidate(readLegacyMigrationSnapshot(db)));
  assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
  assert.deepEqual(db.prepare('SELECT * FROM ec_posts').all(), before);
  assert.equal(db.prepare('SELECT data FROM revisions').get().data, revision);
  for (const visibility of ['members', 'paid', 'free', 'unknown', null, undefined]) {
   for (const retained of [false, true]) {
    db.prepare('UPDATE ec_posts SET visibility=?,ghost_product_slugs=?').run(retained ? 'public' : visibility ?? null, '{}');
    db.prepare('UPDATE revisions SET data=?').run(JSON.stringify({ visibility: retained ? visibility : 'public', ghost_product_slugs: {} }));
    assert.ok(codes(auditLegacyDatabase(db)).includes('invalid_record'));
   }
  }
  db.prepare('UPDATE ec_posts SET visibility=?,ghost_product_slugs=?').run('public', '{"paid":true}');
  db.prepare('UPDATE revisions SET data=?').run(revision);
  assert.ok(codes(auditLegacyDatabase(db)).includes('invalid_record'));
  db.prepare('UPDATE ec_posts SET ghost_product_slugs=?').run('{}');
  db.prepare('UPDATE revisions SET data=?').run('{"visibility":"public","ghost_product_slugs":{"paid":true}}');
  assert.ok(codes(auditLegacyDatabase(db)).includes('invalid_record'));
 } finally { db.close(); }
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

// Independently assembled synthetic collector evidence. No provider is contacted.
const fixtureCanonical = value => Array.isArray(value) ? `[${value.map(fixtureCanonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fixtureCanonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const fixtureHash = value => createHash('sha256').update(fixtureCanonical(value)).digest('hex');
const fixtureOrder = values => [...values].sort((a, b) => {
 const left = fixtureCanonical(a), right = fixtureCanonical(b);
 return left < right ? -1 : left > right ? 1 : 0;
});
const fixtureTime = '2026-10-15T12:00:00.000Z';
const fixtureCustomer = (email = 'member@synthetic.example', stripeCustomerId = 'cus_syntheticMember') => ({ email, stripeCustomerId, createdAt: fixtureTime, updatedAt: fixtureTime });
function insertNativeCustomers(db, customers) {
 db.exec('BEGIN');
 try {
  for (const customer of customers) db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'customers', customer.email, JSON.stringify(customer));
  const members = Object.fromEntries(customers.map(({ email, stripeCustomerId, migrationBinding }) => [email, { stripeCustomerId, migrationBinding }]));
  db.prepare('INSERT INTO options VALUES(?,?)').run(REGISTRY, JSON.stringify({ version: 1, members }));
  db.exec('COMMIT');
 } catch (error) { db.exec('ROLLBACK'); throw error; }
}
const editRegistry = (db, change) => {
 const registry = JSON.parse(db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY).value);
 change(registry);
 db.prepare('UPDATE options SET value=? WHERE name=?').run(JSON.stringify(registry), REGISTRY);
};
const attestationOptions = attestation => {
 const reviewedAccountAttestationJson = `${JSON.stringify(attestation, null, 2)}\n`;
 return { reviewedAccountAttestationJson, approvedAccountAttestationSha256: migrationReceiptSha256(reviewedAccountAttestationJson) };
};
function attestedDatabase(path, customers = [fixtureCustomer(' Member@Synthetic.Example '), fixtureCustomer('second@synthetic.example', 'cus_syntheticSecond')], account = 'acct_fixture') {
 const db = database(path);
 db.prepare('DELETE FROM options WHERE name=?').run(`plugin:${LEGACY}:stripe_account_id`);
 db.prepare('UPDATE options SET value=? WHERE name=?').run(JSON.stringify(account), `plugin:${NATIVE}:settings:stripeAccountId`);
 // Raw representations intentionally include formatting/envelope bytes.
 const legacyCredentials = [
  { name: `plugin:${LEGACY}:stripe_secret_key`, value: ' {"encrypted":"SYNTHETIC_LEGACY_ENVELOPE"} ' },
  { name: `plugin:${LEGACY}:stripe_publishable_key`, value: '"SYNTHETIC_PUBLIC_REPRESENTATION"' },
 ];
 for (const { name, value } of legacyCredentials) db.prepare('INSERT INTO options VALUES(?,?)').run(name, value);
 const customerRows = customers.map(data => ({ id: data.email.trim().toLowerCase(), data: JSON.stringify(data) }));
 for (const row of customerRows) db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(LEGACY, 'customers', row.id, row.data);
 for (const collection of ['sessions', 'authTokens']) db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(LEGACY, collection, 'SYNTHETIC_PRIVATE_TOKEN', 'SYNTHETIC_PRIVATE_SESSION');
 const settings = [
  { name: `plugin:${LEGACY}:plan_mappings`, value: '{"default-product":"prod_fixture"}' },
  { name: `plugin:${LEGACY}:stripe_environment`, value: '"test"' }, ...legacyCredentials,
 ];
 const associations = customerRows.map(row => { const data = JSON.parse(row.data); return [row.id, data.stripeCustomerId]; });
 const attestation = {
  kind: 'paid-access-legacy-account-attestation', version: 1, observedAt: 1,
  accountId: account, environment: 'test',
  sourceSha256: fixtureHash({ customers: fixtureOrder(customerRows), settings: fixtureOrder(settings) }),
  coverageSha256: fixtureHash({ products: ['prod_fixture'], customers: fixtureOrder(associations) }),
  customerCount: 2, productCount: 1,
  nativeCredentialRepresentationSha256: fixtureHash('"SYNTHETIC_ONLY"'),
  credentialSha256: createHash('sha256').update('SYNTHETIC_ONLY', 'utf8').digest('hex'),
 };
 const migrationBinding = { version: 1, accountId: attestation.accountId, environment: 'test', sourceSha256: attestation.sourceSha256, credentialSha256: attestation.credentialSha256 };
 insertNativeCustomers(db, customerRows.map(row => ({ ...JSON.parse(row.data), email: row.id, migrationBinding })));
 return { db, attestation, options: attestationOptions(attestation) };
}
const identitySnapshot = db => readLegacyMigrationSnapshot(db, { includeIdentityBinding: true });
const approveAttested = (db, options) => ({ ...options, ...receiptOptions(createMigrationReviewCandidate(identitySnapshot(db), options)) });
const editCustomer = (db, plugin, id, change) => {
 const row = db.prepare("SELECT data FROM _plugin_storage WHERE plugin_id=? AND collection='customers' AND id=?").get(plugin, id);
 const data = JSON.parse(row.data); change(data);
 db.prepare("UPDATE _plugin_storage SET data=? WHERE plugin_id=? AND collection='customers' AND id=?").run(JSON.stringify(data), plugin, id);
};
// Synthetic migration preparation after a historical source change; never audit behavior.
const rebindAttestedSource = (db, attestation) => {
 const source = readLegacyMigrationIdentitySource(db);
 for (const { id } of db.prepare("SELECT id FROM _plugin_storage WHERE plugin_id=? AND collection='customers'").all(NATIVE)) editCustomer(db, NATIVE, id, data => data.migrationBinding.sourceSha256 = source.sourceSha256);
 editRegistry(db, registry => {
  for (const member of Object.values(registry.members)) member.migrationBinding.sourceSha256 = source.sourceSha256;
 });
 return attestationOptions({ ...attestation, sourceSha256: source.sourceSha256 });
};

test('preimport source capture precedes native setup and final binding without changing legacy bytes', () => {
 const db = database();
 try {
  db.prepare('DELETE FROM options WHERE name LIKE ? OR name=?').run(`plugin:${NATIVE}:%`, `plugin:${LEGACY}:stripe_account_id`);
  db.prepare('DELETE FROM _plugin_storage WHERE plugin_id=?').run(NATIVE);
  const customer = fixtureCustomer();
  db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(LEGACY, 'customers', customer.email, JSON.stringify(customer));
  db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_secret_key`, ' {"encrypted":"SYNTHETIC_SOURCE_ENVELOPE"} ');
  for (const plugin of [LEGACY, NATIVE]) for (const collection of ['sessions', 'authTokens', 'auth_tokens']) db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(plugin, collection, 'SYNTHETIC_PRIVATE_TOKEN', 'SYNTHETIC_PRIVATE_SESSION');
  const legacyBytes = () => JSON.stringify([
   db.prepare('SELECT collection,id,data FROM _plugin_storage WHERE plugin_id=? ORDER BY collection,id').all(LEGACY),
   db.prepare('SELECT name,value FROM options WHERE name LIKE ? ORDER BY name').all(`plugin:${LEGACY}:%`),
  ]);
  const before = legacyBytes(), calls = [];
  const wrapper = { prepare(sql) {
   assert.match(sql, /^SELECT /); calls.push(sql);
   if (sql.startsWith('SELECT plugin_id AS plugin, id, data')) assert.match(sql, /WHERE plugin_id='restrict-with-stripe' AND collection='customers'/);
   if (sql.startsWith('SELECT name, value FROM options')) assert.equal(sql.includes('paid-access'), false);
   return db.prepare(sql);
  } };
  const source = readLegacyMigrationIdentitySource(wrapper);
  assert.deepEqual(Object.keys(source).sort(), ['sourceSha256', 'coverageSha256', 'customerCount', 'productCount', 'customerAssociationsSha256'].sort());
  assert.equal(source.customerCount, 1); assert.equal(source.productCount, 1);
  assert.equal(source.sourceSha256, fixtureHash({ customers: [{ id: customer.email, data: JSON.stringify(customer) }], settings: fixtureOrder(db.prepare('SELECT name,value FROM options WHERE name LIKE ?').all(`plugin:${LEGACY}:%`)) }));
  assert.ok(calls.some(sql => sql.includes('THEN data ELSE NULL END')));
  assert.ok(calls.some(sql => sql.startsWith('SELECT name, CASE WHEN')));
  assert.equal(legacyBytes(), before);
  assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/);
  for (const row of snapshot().settings.filter(row => row.plugin === NATIVE)) db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${NATIVE}:settings:${row.key}`, row.key === 'stripeSecretKey' ? '"SYNTHETIC_ONLY"' : row.value);
  db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'restrictions', 'posts:item', rule(NATIVE).data);
  assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/);
  const credentialSha256 = createHash('sha256').update('SYNTHETIC_ONLY', 'utf8').digest('hex');
  assert.notEqual(credentialSha256, fixtureHash('SYNTHETIC_ONLY'));
  const migrationBinding = { version: 1, accountId: 'acct_fixture', environment: 'test', sourceSha256: source.sourceSha256, credentialSha256 };
  insertNativeCustomers(db, [{ ...customer, migrationBinding }]);
  const descriptor = readLegacyMigrationIdentityBinding(db);
  for (const key of Object.keys(source)) assert.equal(descriptor[key], source[key]);
  assert.equal(descriptor.credentialSha256, credentialSha256);
  assert.equal(descriptor.nativeCredentialRepresentationSha256, fixtureHash('"SYNTHETIC_ONLY"'));
  const options = attestationOptions({ kind: 'paid-access-legacy-account-attestation', version: 1, observedAt: 1, accountId: 'acct_fixture', environment: 'test', sourceSha256: source.sourceSha256, coverageSha256: source.coverageSha256, customerCount: 1, productCount: 1, nativeCredentialRepresentationSha256: descriptor.nativeCredentialRepresentationSha256, credentialSha256 });
  const approved = approveAttested(db, options);
  assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
  assert.equal(legacyBytes(), before);
  const rendered = JSON.stringify([source, descriptor, createMigrationReviewCandidate(identitySnapshot(db), options), auditLegacyDatabase(db, approved)]);
  for (const value of ['member@', 'cus_', 'prod_', 'acct_', 'SYNTHETIC_', '"environment"']) assert.equal(rendered.includes(value), false);
  db.prepare('UPDATE options SET value=? WHERE name=?').run('MALFORMED_SYNTHETIC_NATIVE_CREDENTIAL', `plugin:${NATIVE}:settings:stripeSecretKey`);
  editCustomer(db, NATIVE, customer.email, data => delete data.migrationBinding);
  db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'customers', 'SYNTHETIC_INVALID', '{broken');
  db.prepare('DELETE FROM options WHERE name=?').run(`plugin:${NATIVE}:settings:stripeAccountId`);
  db.prepare('UPDATE options SET value=? WHERE name=?').run('{SYNTHETIC_BROKEN_REGISTRY', REGISTRY);
  assert.deepEqual(readLegacyMigrationIdentitySource(wrapper), source);
  assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
  assert.equal(legacyBytes(), before);
 } finally { db.close(); }
});
test('source-only capture enforces data_version across redacted snapshot and private source stage', () => {
 const { db } = attestedDatabase();
 try {
  for (const changedAt of [2, 3, 4]) {
   let calls = 0;
   const wrapper = { prepare(sql) { return sql === 'SELECT data_version FROM pragma_data_version' ? { all() { return [{ data_version: ++calls >= changedAt ? 2 : 1 }]; } } : db.prepare(sql); } };
   assert.throws(() => readLegacyMigrationIdentitySource(wrapper), { message: 'Migration identity evidence is unavailable or unsupported.' });
  }
 } finally { db.close(); }
});

test('v1 candidate remains byte-for-byte compatible and ignores opt-in descriptors', () => {
 const s = snapshot();
 assert.equal(migrationReceiptSha256(JSON.stringify(createMigrationReviewCandidate(s))), '1290909398087070d77e260369775c4c0bd165ff6d399d47123d0c7403103837');
 s.identityBinding = { unsupported: true };
 assert.equal(migrationReceiptSha256(JSON.stringify(createMigrationReviewCandidate(s))), '1290909398087070d77e260369775c4c0bd165ff6d399d47123d0c7403103837');
});
test('pinned derived-v1 receipts cannot approve members with matching historical accounts or lost native identities', () => {
 for (const scenario of ['intact identity', 'stripped registry and bindings', 'missing native row', 'removed native customers and registry']) {
  const { db, attestation } = attestedDatabase();
  try {
   db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, JSON.stringify(attestation.accountId));
   const options = rebindAttestedSource(db, attestation);
   const approved = approveAttested(db, options);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
   const { accountAttestationSha256, identityBinding, ...v1 } = JSON.parse(approved.reviewedReceiptJson);
   assert.ok(accountAttestationSha256);
   assert.equal(identityBinding.customerCount, 2);
   v1.version = 1;
   const pinnedV1 = receiptOptions(v1);
   // Derive and independently pin real review bytes; only v2 identity evidence is removed.
   assert.equal(pinnedV1.approvedReceiptSha256, createHash('sha256').update(pinnedV1.reviewedReceiptJson, 'utf8').digest('hex'));
   assert.throws(() => createMigrationReviewCandidate(identitySnapshot(db)), /unresolved blockers/);
   if (scenario === 'stripped registry and bindings') {
    for (const id of ['member@synthetic.example', 'second@synthetic.example']) editCustomer(db, NATIVE, id, data => delete data.migrationBinding);
   }
   if (scenario === 'missing native row') db.prepare("DELETE FROM _plugin_storage WHERE plugin_id=? AND collection='customers' AND id=?").run(NATIVE, 'member@synthetic.example');
   if (scenario === 'removed native customers and registry') db.prepare("DELETE FROM _plugin_storage WHERE plugin_id=? AND collection='customers'").run(NATIVE);
   if (['stripped registry and bindings', 'removed native customers and registry'].includes(scenario)) db.prepare('DELETE FROM options WHERE name=?').run(REGISTRY);
   const s = readLegacyMigrationSnapshot(db);
   assert.equal(auditLegacyMigration(s).counts.legacyCustomers, 2, scenario);
   assert.throws(() => createMigrationReviewCandidate(s), /unresolved blockers/, scenario);
   for (const report of [auditLegacyMigration(s, pinnedV1), auditLegacyDatabase(db, pinnedV1)]) {
    // Receipt parity still clears only the review blocker; v1 cannot waive attestation.
    assert.deepEqual(codes(report), ['account_attestation_mismatch'], scenario);
    assert.equal(report.safeToReplaceLegacy, false, scenario);
   }
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, scenario === 'intact identity', scenario);
  } finally { db.close(); }
 }
});
test('identity source and v2 receipt ordering are locale independent', t => {
 const compare = String.prototype.localeCompare;
 let evidence;
 // A valid new-path audit has one pending-review blocker, requiring no blocker sort.
 String.prototype.localeCompare = () => { throw new Error('new identity path called localeCompare'); };
 try {
  const { db, options, attestation } = attestedDatabase(undefined, [fixtureCustomer('ä@synthetic.example', 'cus_syntheticAccent'), fixtureCustomer('z@synthetic.example', 'cus_syntheticZ')]);
  try {
   const native = db.prepare("SELECT data FROM _plugin_storage WHERE plugin_id=? AND collection='customers'").all(NATIVE).map(row => JSON.parse(row.data));
   db.prepare("DELETE FROM _plugin_storage WHERE plugin_id=? AND collection='customers'").run(NATIVE);
   db.prepare('DELETE FROM options WHERE name=?').run(REGISTRY);
   const source = readLegacyMigrationIdentitySource(db);
   assert.equal(source.sourceSha256, attestation.sourceSha256);
   assert.equal(source.coverageSha256, attestation.coverageSha256);
   insertNativeCustomers(db, native);
   // Exercise review source/native rules, metadata entries and taxonomy-term arrays.
   db.prepare('DELETE FROM _plugin_storage WHERE collection=?').run('restrictions');
   for (const id of ['ä', 'z']) {
    for (const plugin of [LEGACY, NATIVE]) {
     const row = rule(plugin, 'restrictions', { contentId: id });
     db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(plugin, row.collection, `posts:${id}`, row.data);
    }
    db.prepare('INSERT INTO ec_posts VALUES(?,?,?,?)').run(id, 'public', '["default-product"]', 'SYNTHETIC_BODY');
   }
   const s = identitySnapshot(db);
   s.entryTerms = ['ä', 'z'].map(id => ({ collection: 'posts', entryId: id, taxonomyName: 'tags', termId: id }));
   const registry = JSON.parse(db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY).value);
   assert.equal(s.identityBinding.nativeCustomerRegistrySha256, fixtureHash(fixtureOrder(Object.entries(registry.members).map(([email, { stripeCustomerId, migrationBinding }]) => [[email, stripeCustomerId], migrationBinding]))));
   const receipt = createMigrationReviewCandidate(s, options);
   assert.equal(receipt.version, 2);
   assert.equal(auditLegacyMigration(s, { ...options, ...receiptOptions(receipt) }).safeToReplaceLegacy, true);
   evidence = { source, identity: s.identityBinding, receiptSha256: migrationReceiptSha256(JSON.stringify(receipt)), sourceSha256: receipt.sourceSha256, nativeSha256: receipt.nativeSha256, metadataSha256: receipt.metadataSha256 };
  } finally { db.close(); }
 } finally { String.prototype.localeCompare = compare; }
 if (process.env.PA_ORDERING_FIXTURE_CHILD === '1') {
  console.log(`IDENTITY_ORDERING_HASHES=${JSON.stringify(evidence)}`);
  return;
 }
 for (const locale of ['en_US.UTF-8', 'sv_SE.UTF-8']) {
  const env = { ...process.env, LANG: locale, LC_ALL: locale, PA_ORDERING_FIXTURE_CHILD: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', '--test-name-pattern=^identity source and v2 receipt ordering are locale independent$', import.meta.filename], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const match = child.stdout.match(/IDENTITY_ORDERING_HASHES=(\{[^\n]+\})/);
  assert.ok(match, child.stdout);
  assert.deepEqual(JSON.parse(match[1]), evidence, locale);
 }
 t.diagnostic(`source=${evidence.source.sourceSha256} receipt-v2=${evidence.receiptSha256}`);
});
test('absent account: attestation preparation stays pending, separately pinned v2 succeeds without expiry', () => {
 const { db, options, attestation } = attestedDatabase();
 try {
  const s = identitySnapshot(db), before = JSON.stringify(s);
  assert.deepEqual(s.identityBinding, readLegacyMigrationIdentityBinding(db));
  assert.equal(s.identityBinding.sourceSha256, attestation.sourceSha256);
  assert.equal(s.identityBinding.coverageSha256, attestation.coverageSha256);
  assert.equal(s.identityBinding.credentialSha256, attestation.credentialSha256);
  const registry = JSON.parse(db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY).value);
  const registryHash = fixtureHash(fixtureOrder(Object.entries(registry.members).map(([email, { stripeCustomerId, migrationBinding }]) => [[email, stripeCustomerId], migrationBinding])));
  assert.equal(s.identityBinding.nativeCustomerRegistrySha256, registryHash);
  assert.equal(registryHash, s.identityBinding.nativeMigrationBindingsSha256);
  assert.equal(registryHash, s.identityBinding.expectedNativeMigrationBindingsSha256);
  assert.deepEqual(codes(auditLegacyMigration(s, options)), ['legacy_migration_review_required']);
  assert.deepEqual(codes(auditLegacyDatabase(db, options)), ['legacy_migration_review_required']);
  const candidate = createMigrationReviewCandidate(s, options);
  assert.equal(candidate.version, 2);
  assert.equal(candidate.accountAttestationSha256, options.approvedAccountAttestationSha256);
  assert.deepEqual(candidate.identityBinding, s.identityBinding);
  const approved = { ...options, ...receiptOptions(candidate) };
  assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
  assert.equal(JSON.stringify(s), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM options WHERE name=?').get(`plugin:${LEGACY}:stripe_account_id`).n, 0);
  assert.equal(auditLegacyMigration(s, receiptOptions(candidate)).safeToReplaceLegacy, false);
  assert.throws(() => createMigrationReviewCandidate(s));
  const weaker = { ...candidate, version: 1 }; delete weaker.identityBinding; delete weaker.accountAttestationSha256;
  assert.equal(auditLegacyMigration(s, { ...options, ...receiptOptions(weaker) }).safeToReplaceLegacy, false);
 } finally { db.close(); }
});
test('supported account shapes roundtrip through SQLite v2 attestation, registry and native settings', () => {
 const unprefixed32 = 'SyntheticAccount0123456789ABCDEF';
 assert.equal(unprefixed32.length, 32);
 for (const account of [unprefixed32, 'acct_a', `acct_${'S'.repeat(255)}`]) {
  const { db, options, attestation } = attestedDatabase(undefined, undefined, account);
  try {
   const s = identitySnapshot(db);
   assert.equal(attestation.accountId, account);
   assert.equal(JSON.parse(s.settings.find(row => row.plugin === NATIVE && row.key === 'stripeAccountId').value), account);
   const registry = JSON.parse(db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY).value);
   for (const member of Object.values(registry.members)) assert.equal(member.migrationBinding.accountId, account);
   assert.equal(s.identityBinding.nativeCustomerRegistrySha256, s.identityBinding.nativeMigrationBindingsSha256);
   assert.equal(s.identityBinding.nativeCustomerRegistrySha256, s.identityBinding.expectedNativeMigrationBindingsSha256);
   assert.deepEqual(codes(auditLegacyDatabase(db, options)), ['legacy_migration_review_required']);
   const candidate = createMigrationReviewCandidate(s, options);
   assert.equal(candidate.version, 2);
   const approved = { ...options, ...receiptOptions(candidate) };
   assert.equal(auditLegacyMigration(s, approved).safeToReplaceLegacy, true);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
  } finally { db.close(); }
 }
});
test('matching present historical accounts require fresh source binding and separately pinned v2 review', t => {
 for (const account of ['acct_fixture', 'SyntheticAccount0123456789ABCDEF']) {
  const { db, options: absentOptions, attestation } = attestedDatabase(undefined, undefined, account);
  try {
   const absentApproved = approveAttested(db, absentOptions);
   const value = ` ${JSON.stringify(account)} `;
   db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, value);
   const source = readLegacyMigrationIdentitySource(db);
   assert.notEqual(source.sourceSha256, attestation.sourceSha256);
   assert.equal(source.sourceSha256, fixtureHash({
    customers: fixtureOrder(db.prepare("SELECT id,data FROM _plugin_storage WHERE plugin_id=? AND collection='customers'").all(LEGACY)),
    settings: fixtureOrder(db.prepare('SELECT name,value FROM options WHERE name LIKE ?').all(`plugin:${LEGACY}:%`)),
   }));
   assert.equal(auditLegacyDatabase(db, absentApproved).safeToReplaceLegacy, false);
   const repinnedOnly = attestationOptions({ ...attestation, sourceSha256: source.sourceSha256 });
   assert.equal(auditLegacyDatabase(db, repinnedOnly).safeToReplaceLegacy, false);
   assert.throws(() => createMigrationReviewCandidate(identitySnapshot(db), repinnedOnly), /identity evidence is unavailable/);
   const options = rebindAttestedSource(db, attestation);
   const originalSettings = db.prepare('SELECT name,value FROM options ORDER BY name').all();
   const readOnly = { prepare(sql) { assert.match(sql, /^SELECT /); return db.prepare(sql); } };
   const s = identitySnapshot(readOnly);
   assert.equal(s.identityBinding.nativeCustomerRegistrySha256, s.identityBinding.nativeMigrationBindingsSha256);
   assert.equal(s.identityBinding.nativeCustomerRegistrySha256, s.identityBinding.expectedNativeMigrationBindingsSha256);
   assert.deepEqual(codes(auditLegacyDatabase(readOnly, options)), ['legacy_migration_review_required']);
   const candidate = createMigrationReviewCandidate(s, options);
   assert.equal(candidate.version, 2);
   assert.equal(candidate.accountAttestationSha256, createHash('sha256').update(options.reviewedAccountAttestationJson, 'utf8').digest('hex'));
   const approved = { ...options, ...receiptOptions(candidate) };
   assert.equal(approved.approvedReceiptSha256, createHash('sha256').update(approved.reviewedReceiptJson, 'utf8').digest('hex'));
   assert.equal(auditLegacyMigration(s, approved).safeToReplaceLegacy, true);
   assert.equal(auditLegacyDatabase(readOnly, approved).safeToReplaceLegacy, true);
   assert.equal(auditLegacyDatabase(readOnly, { ...options, ...receiptOptions(JSON.parse(absentApproved.reviewedReceiptJson)) }).safeToReplaceLegacy, false);
   assert.equal(auditLegacyDatabase(readOnly, receiptOptions(candidate)).safeToReplaceLegacy, false);
   assert.deepEqual(db.prepare('SELECT name,value FROM options ORDER BY name').all(), originalSettings);
   t.diagnostic(`source=${source.sourceSha256} attestation=${options.approvedAccountAttestationSha256} receipt-v2=${approved.approvedReceiptSha256} customers=${source.customerCount} products=${source.productCount}`);
  } finally { db.close(); }
 }
});
test('pinned matching-account v2 review denies registry, binding and historical account drift', () => {
 for (const mutate of [
  db => db.prepare('DELETE FROM options WHERE name=?').run(REGISTRY),
  db => editCustomer(db, NATIVE, 'member@synthetic.example', data => delete data.migrationBinding),
  db => db.prepare('DELETE FROM options WHERE name=?').run(`plugin:${LEGACY}:stripe_account_id`),
  ...['"acct_other"', 'null', '""', '{broken', ' "acct_fixture" '].map(value => db => db.prepare('UPDATE options SET value=? WHERE name=?').run(value, `plugin:${LEGACY}:stripe_account_id`)),
 ]) {
  const { db, attestation } = attestedDatabase();
  try {
   db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, '"acct_fixture"');
   const options = rebindAttestedSource(db, attestation), approved = approveAttested(db, options);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
   mutate(db);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
   assert.throws(() => createMigrationReviewCandidate(identitySnapshot(db), options));
  } finally { db.close(); }
 }
});
test('repinned attestation cannot override invalid or duplicate present historical accounts', () => {
 for (const value of [null, 'null', '""', '"acct_other"', '{broken', '" acct_fixture "', '"acct_under_score"', '"acct_fixture\\n"', '123', '{}', '[]']) {
  const { db, attestation } = attestedDatabase();
  try {
   db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, value);
   const options = rebindAttestedSource(db, attestation), s = identitySnapshot(db);
   assert.ok(codes(auditLegacyMigration(s, options)).includes('account_attestation_mismatch'));
   assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false);
   assert.throws(() => createMigrationReviewCandidate(s, options), /unresolved blockers/);
  } finally { db.close(); }
 }
 const { db, attestation } = attestedDatabase();
 try {
  db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, '"acct_fixture"');
  const options = rebindAttestedSource(db, attestation), s = identitySnapshot(db);
  s.settings.push(setting(LEGACY, 'stripe_account_id', 'acct_fixture'));
  assert.ok(codes(auditLegacyMigration(s, options)).includes('account_attestation_mismatch'));
  assert.throws(() => createMigrationReviewCandidate(s, options), /unresolved blockers/);
  db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, '"acct_fixture"');
  assert.throws(() => readLegacyMigrationIdentitySource(db), /identity evidence is unavailable/);
  assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false);
 } finally { db.close(); }
});
test('supported account shapes reject invalid values and trailing line endings', () => {
 for (const account of ['', ' Synthetic', 'Synthetic ', 'Synthetic Account', 'Synthetic\tAccount', 'Synthetic\0Account', 'Synthetic\nAccount', 'Synthetic\u2028', 'https://synthetic.example', 'Synthetic/Account', 'Synthetic:Account', 'S'.repeat(256), '-Synthetic', '_Synthetic', 'Synthétic', 'A'.repeat(31), 'A'.repeat(33), `acct_${'S'.repeat(256)}`, 'acct_under_score', `${'A'.repeat(32)}\n`, `${'A'.repeat(32)}\r\n`, 'acct_a\n', 'acct_a\r\n']) {
  const fixture = attestedDatabase();
  try {
   const s = identitySnapshot(fixture.db);
   s.settings.find(row => row.plugin === NATIVE && row.key === 'stripeAccountId').value = JSON.stringify(account);
   const options = attestationOptions({ ...fixture.attestation, accountId: account });
   assert.ok(codes(auditLegacyMigration(s, options)).includes('account_attestation_mismatch'));
   assert.throws(() => createMigrationReviewCandidate(s, options));
  } finally { fixture.db.close(); }
  const { db, options } = attestedDatabase(undefined, undefined, account);
  try {
   assert.throws(() => readLegacyMigrationIdentityBinding(db), { message: 'Migration identity evidence is unavailable or unsupported.' });
   assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false);
  } finally { db.close(); }
 }
});
test('receipt and attestation pairs are independently optional but partial/unknown options fail closed', () => {
 const { db, options } = attestedDatabase();
 try {
  const s = identitySnapshot(db), approved = approveAttested(db, options);
  for (const invalid of [
   { reviewedAccountAttestationJson: options.reviewedAccountAttestationJson },
   { approvedAccountAttestationSha256: options.approvedAccountAttestationSha256 },
   { ...options, approvedAccountAttestationSha256: '0'.repeat(64) },
   { ...options, reviewedAccountAttestationJson: options.reviewedAccountAttestationJson + ' ' },
   { ...options, typo: true }, { ...approved, typo: true },
   { ...options, reviewedReceiptJson: approved.reviewedReceiptJson },
   { ...options, approvedReceiptSha256: approved.approvedReceiptSha256 }, null, [],
  ]) assert.equal(auditLegacyMigration(s, invalid).safeToReplaceLegacy, false);
  for (const invalid of [{ ...options, typo: true }, { ...options, reviewedReceiptJson: approved.reviewedReceiptJson }, { ...options, approvedReceiptSha256: approved.approvedReceiptSha256 }, { reviewedAccountAttestationJson: options.reviewedAccountAttestationJson }]) assert.throws(() => createMigrationReviewCandidate(s, invalid), /unresolved blockers/);
  assert.equal(auditLegacyMigration(snapshot(), { ...receiptOptions(createMigrationReviewCandidate(snapshot())), typo: true }).safeToReplaceLegacy, false);
 } finally { db.close(); }
});
test('attestation schema is closed, strictly bounded and externally pinned', () => {
 const { db, attestation } = attestedDatabase();
 try {
  const s = identitySnapshot(db);
  for (const patch of [{ extra: 'private' }, { kind: 'other' }, { version: 2 }, { observedAt: 0 }, { observedAt: 1.5 }, { observedAt: Number.MAX_SAFE_INTEGER + 1 }, { accountId: 'acct_bad_id' }, { accountId: '' }, { environment: 'sandbox' }, { customerCount: -1 }, { customerCount: 100001 }, { productCount: 1.5 }, { sourceSha256: 'A'.repeat(64) }, { coverageSha256: 'f'.repeat(63) }, { nativeCredentialRepresentationSha256: null }, { credentialSha256: 'private' }]) {
   const options = attestationOptions({ ...attestation, ...patch });
   assert.ok(codes(auditLegacyMigration(s, options)).includes('account_attestation_mismatch'));
   assert.throws(() => createMigrationReviewCandidate(s, options));
  }
  const missing = { ...attestation }; delete missing.observedAt;
  assert.throws(() => createMigrationReviewCandidate(s, attestationOptions(missing)));
 } finally { db.close(); }
});
test('account attestation refuses unreviewed historical source changes or environment mismatch', () => {
 for (const value of ['""', 'null', '"acct_fixture"', '"acct_other"', '{broken', '" acct_fixture "']) {
  const { db, options } = attestedDatabase();
  try {
   db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, value);
   assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false);
   assert.throws(() => identitySnapshot(db), /identity evidence is unavailable/);
  } finally { db.close(); }
 }
 for (const [key, value] of [[`plugin:${LEGACY}:stripe_environment`, 'live'], [`plugin:${LEGACY}:stripe_environment`, ''], [`plugin:${NATIVE}:settings:stripeEnvironment`, 'live'], [`plugin:${NATIVE}:settings:stripeAccountId`, 'acct_other']]) {
  const { db, options } = attestedDatabase();
  try { db.prepare('UPDATE options SET value=? WHERE name=?').run(JSON.stringify(value), key); assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false); }
  finally { db.close(); }
 }
 const { db, options } = attestedDatabase();
 try {
  db.prepare('UPDATE options SET value=? WHERE name=?').run('"sandbox"', `plugin:${NATIVE}:settings:stripeEnvironment`);
  assert.deepEqual(codes(auditLegacyDatabase(db, options)), ['legacy_migration_review_required']);
 } finally { db.close(); }
});
test('every identity descriptor digest/count is pinned and raw source/credential drift blocks boot', () => {
 const { db, options } = attestedDatabase();
 try {
  const s = identitySnapshot(db), approved = approveAttested(db, options);
  for (const key of Object.keys(s.identityBinding)) {
   const changed = structuredClone(s);
   changed.identityBinding[key] = typeof changed.identityBinding[key] === 'number' ? changed.identityBinding[key] + 1 : '0'.repeat(64);
   assert.equal(auditLegacyMigration(changed, approved).safeToReplaceLegacy, false, key);
  }
 } finally { db.close(); }
 for (const mutate of [
  db => db.prepare('UPDATE options SET value=value || ? WHERE name=?').run(' ', `plugin:${LEGACY}:stripe_secret_key`),
  db => db.prepare('UPDATE options SET value=value || ? WHERE name=?').run(' ', `plugin:${LEGACY}:plan_mappings`),
  db => db.prepare("UPDATE _plugin_storage SET data=data || ' ' WHERE plugin_id=? AND collection='customers'").run(LEGACY),
  db => db.prepare('UPDATE options SET value=? WHERE name=?').run('"SYNTHETIC_REPLACEMENT"', `plugin:${NATIVE}:settings:stripeSecretKey`),
  db => editCustomer(db, NATIVE, 'member@synthetic.example', data => data.migrationBinding.credentialSha256 = '0'.repeat(64)),
  db => { for (const id of ['member@synthetic.example', 'second@synthetic.example']) editCustomer(db, NATIVE, id, data => data.migrationBinding.credentialSha256 = '0'.repeat(64)); },
 ]) {
  const { db, options } = attestedDatabase();
  try { const approved = approveAttested(db, options); mutate(db); assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false); }
  finally { db.close(); }
 }
});
test('exact inherited customer associations and complete native migration bindings are mandatory', () => {
 for (const mutate of [
  db => editCustomer(db, LEGACY, 'member@synthetic.example', data => data.stripeCustomerId = 'cus_changedSameCount'),
  db => editCustomer(db, NATIVE, 'member@synthetic.example', data => data.stripeCustomerId = 'cus_changedSameCount'),
  db => { for (const plugin of [LEGACY, NATIVE]) editCustomer(db, plugin, 'member@synthetic.example', data => data.stripeCustomerId = 'cus_changedSameCount'); },
  db => editCustomer(db, NATIVE, 'member@synthetic.example', data => delete data.migrationBinding),
  ...['accountId', 'environment', 'sourceSha256'].map(key => db => editCustomer(db, NATIVE, 'member@synthetic.example', data => data.migrationBinding[key] = key === 'accountId' ? 'acct_other' : key === 'environment' ? 'live' : '0'.repeat(64))),
  db => db.prepare("DELETE FROM _plugin_storage WHERE plugin_id=? AND collection='customers' AND id=?").run(NATIVE, 'member@synthetic.example'),
 ]) {
  const { db, options } = attestedDatabase();
  try { const approved = approveAttested(db, options); mutate(db); assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false); }
  finally { db.close(); }
 }
});
test('closed native registry refuses row loss, membership drift, mismatches and unsupported JSON', () => {
 const first = 'member@synthetic.example', second = 'second@synthetic.example';
 for (const [reason, mutate] of [
  ['missing native row', db => db.prepare("DELETE FROM _plugin_storage WHERE plugin_id=? AND collection='customers' AND id=?").run(NATIVE, first)],
  ['stripped native binding', db => editCustomer(db, NATIVE, first, data => delete data.migrationBinding)],
  ['missing registry', db => db.prepare('DELETE FROM options WHERE name=?').run(REGISTRY)],
  ['wrong storage namespace', db => {
   const { value } = db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY);
   db.prepare('DELETE FROM options WHERE name=?').run(REGISTRY);
   db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, '__kv', 'migration:customer-bindings:v1', value);
  }],
  ['missing member', db => editRegistry(db, registry => delete registry.members[first])],
  ['extra member', db => editRegistry(db, registry => registry.members['future@synthetic.example'] = { ...registry.members[first], stripeCustomerId: 'cus_futureSynthetic' })],
  ['unnormalized member', db => editRegistry(db, registry => { registry.members[' Member@Synthetic.Example '] = registry.members[first]; delete registry.members[first]; })],
  ['duplicate customer ID', db => editRegistry(db, registry => registry.members[second].stripeCustomerId = registry.members[first].stripeCustomerId)],
  ['wrong customer ID', db => editRegistry(db, registry => registry.members[first].stripeCustomerId = 'cus_wrongSynthetic')],
  ['matching native and registry IDs differ from original', db => {
   editCustomer(db, NATIVE, first, data => data.stripeCustomerId = 'cus_wrongSynthetic');
   editRegistry(db, registry => registry.members[first].stripeCustomerId = 'cus_wrongSynthetic');
  }],
  ['stripped registry binding', db => editRegistry(db, registry => delete registry.members[first].migrationBinding)],
  ...['accountId', 'environment', 'sourceSha256', 'credentialSha256'].map(key => [`wrong registry ${key}`, db => editRegistry(db, registry => registry.members[first].migrationBinding[key] = key === 'accountId' ? 'acct_other' : key === 'environment' ? 'live' : '0'.repeat(64))]),
  ['matching wrong source bindings', db => {
   editCustomer(db, NATIVE, first, data => data.migrationBinding.sourceSha256 = '0'.repeat(64));
   editRegistry(db, registry => registry.members[first].migrationBinding.sourceSha256 = '0'.repeat(64));
  }],
  ['matching wrong credential fingerprints', db => {
   for (const id of [first, second]) editCustomer(db, NATIVE, id, data => data.migrationBinding.credentialSha256 = '0'.repeat(64));
   editRegistry(db, registry => { for (const member of Object.values(registry.members)) member.migrationBinding.credentialSha256 = '0'.repeat(64); });
  }],
  ['unknown envelope field', db => editRegistry(db, registry => registry.extra = true)],
  ['unknown member field', db => editRegistry(db, registry => registry.members[first].email = first)],
  ['unknown binding field', db => editRegistry(db, registry => registry.members[first].migrationBinding.extra = true)],
  ['wrong version', db => editRegistry(db, registry => registry.version = 2)],
  ['nonobject members', db => editRegistry(db, registry => registry.members = [])],
  ['duplicate options rows', db => db.prepare('INSERT INTO options SELECT name,value FROM options WHERE name=?').run(REGISTRY)],
  ['duplicate envelope field', db => {
   const { value } = db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY);
   db.prepare('UPDATE options SET value=? WHERE name=?').run(value.replace('"version":1', '"version":1,"version":1'), REGISTRY);
  }],
  ...['{broken', 'null', '[]', '{"version":1,"version":1,"members":{}}'].map(json => ['malformed envelope', db => db.prepare('UPDATE options SET value=? WHERE name=?').run(json, REGISTRY)]),
  ['duplicate member key', db => {
   const registry = JSON.parse(db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY).value);
   const member = `${JSON.stringify(first)}:${JSON.stringify(registry.members[first])}`;
   db.prepare('UPDATE options SET value=? WHERE name=?').run(`{"version":1,"members":{${member},${member},${JSON.stringify(second)}:${JSON.stringify(registry.members[second])}}}`, REGISTRY);
  }],
  ['duplicate binding field', db => {
   const { value } = db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY);
   db.prepare('UPDATE options SET value=? WHERE name=?').run(value.replace('"accountId":', '"accountId":"acct_hidden","accountId":'), REGISTRY);
  }],
  ['serialized byte overflow', db => {
   const { value } = db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY);
   db.prepare('UPDATE options SET value=? WHERE name=?').run(value.padEnd(100_001), REGISTRY);
  }],
 ]) {
  const { db, options } = attestedDatabase();
  try {
   const approved = approveAttested(db, options), source = readLegacyMigrationIdentitySource(db);
   mutate(db);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false, reason);
   // The collector fingerprint is independently pinned by the attestation;
   // all other cases must already refuse in the full private reader.
   if (reason !== 'matching wrong credential fingerprints') assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/, reason);
   assert.deepEqual(readLegacyMigrationIdentitySource(db), source, reason);
  } finally { db.close(); }
 }
});
test('reviewed blocked historical identities preserve mixed and all-blocked v2 cohorts without writes', t => {
 for (const presentAccount of [false, true]) for (const blockedCount of [1, 2]) {
  const { db, options: absentOptions, attestation } = attestedDatabase();
  try {
   if (presentAccount) db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:stripe_account_id`, '"acct_fixture"');
   const options = presentAccount ? rebindAttestedSource(db, attestation) : absentOptions;
   const source = readLegacyMigrationIdentitySource(db), active = readLegacyMigrationIdentityBinding(db);
   const customerRows = db.prepare('SELECT * FROM _plugin_storage ORDER BY plugin_id,collection,id').all();
   editRegistry(db, registry => {
    Object.values(registry.members).slice(0, blockedCount).forEach(member => member.blocked = true);
   });
   const readOnly = { prepare(sql) { assert.match(sql, /^SELECT /); return db.prepare(sql); } };
   const s = identitySnapshot(readOnly), identity = s.identityBinding;
   const registry = JSON.parse(db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY).value);
   const pairs = Object.entries(registry.members).map(([email, { stripeCustomerId, migrationBinding, blocked }]) => {
    const core = [[email, stripeCustomerId], migrationBinding];
    return blocked ? [...core, { blocked: true }] : core;
   });
   assert.equal(Object.values(registry.members).filter(member => !Object.hasOwn(member, 'blocked')).length, 2 - blockedCount);
   assert.equal(identity.nativeCustomerRegistrySha256, fixtureHash(fixtureOrder(pairs)));
   assert.notEqual(identity.nativeCustomerRegistrySha256, active.nativeCustomerRegistrySha256);
   assert.equal(identity.nativeCustomerRegistryBindingsSha256, active.nativeCustomerRegistrySha256);
   assert.equal(identity.nativeCustomerRegistryBindingsSha256, identity.nativeMigrationBindingsSha256);
   assert.equal(identity.nativeCustomerRegistryBindingsSha256, identity.expectedNativeMigrationBindingsSha256);
   assert.deepEqual(readLegacyMigrationIdentitySource(readOnly), source);
   assert.deepEqual(codes(auditLegacyDatabase(readOnly, options)), ['legacy_migration_review_required']);
   const candidate = createMigrationReviewCandidate(s, options), approved = { ...options, ...receiptOptions(candidate) };
   assert.deepEqual(candidate.identityBinding, identity);
   const settings = db.prepare('SELECT name,value FROM options ORDER BY name').all();
   assert.equal(auditLegacyMigration(s, approved).safeToReplaceLegacy, true);
   assert.equal(auditLegacyDatabase(readOnly, approved).safeToReplaceLegacy, true);
   assert.equal(auditLegacyDatabase(readOnly, approved).safeToReplaceLegacy, true);
   assert.deepEqual(db.prepare('SELECT * FROM _plugin_storage ORDER BY plugin_id,collection,id').all(), customerRows);
   assert.deepEqual(db.prepare('SELECT name,value FROM options ORDER BY name').all(), settings);
   if (!presentAccount && blockedCount === 1) t.diagnostic(`synthetic-only source=${source.sourceSha256} registry=${identity.nativeCustomerRegistrySha256} bindings=${identity.nativeCustomerRegistryBindingsSha256} receipt-v2=${approved.approvedReceiptSha256}`);
  } finally { db.close(); }
 }
});
test('existing pinned v2 receipt refuses removing, changing, adding or moving a blocked disposition', () => {
 const first = 'member@synthetic.example', second = 'second@synthetic.example';
 for (const mutate of [
  registry => delete registry.members[first].blocked,
  registry => registry.members[first].blocked = false,
  registry => registry.members[second].blocked = true,
  registry => { delete registry.members[first].blocked; registry.members[second].blocked = true; },
 ]) {
  const { db, options } = attestedDatabase();
  try {
   editRegistry(db, registry => registry.members[first].blocked = true);
   const approved = approveAttested(db, options), source = readLegacyMigrationIdentitySource(db);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
   editRegistry(db, mutate);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
   assert.deepEqual(readLegacyMigrationIdentitySource(db), source);
  } finally { db.close(); }
 }
});
test('malformed, duplicate and out-of-scope blocked fields refuse even preparation', () => {
 const first = 'member@synthetic.example';
 for (const mutate of [
  ...[false, null, 'true', 'undefined', 0, 1, {}, []].map(value => db => editRegistry(db, registry => registry.members[first].blocked = value)),
  ...['undefined', 'true,"blocked":true', 'false,"blocked":true', 'true,"bl\\u006fcked":true'].map(value => db => {
   const row = db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY);
   db.prepare('UPDATE options SET value=? WHERE name=?').run(row.value.replace('"blocked":true', `"blocked":${value}`), REGISTRY);
  }),
  db => editRegistry(db, registry => registry.members[first].extra = true),
  db => editRegistry(db, registry => registry.members[first].migrationBinding.blocked = true),
  db => editRegistry(db, registry => registry.members['future@synthetic.example'] = { ...registry.members[first], stripeCustomerId: 'cus_futureSynthetic' }),
  db => editCustomer(db, NATIVE, first, data => data.blocked = true),
 ]) {
  const { db, options } = attestedDatabase();
  try {
   editRegistry(db, registry => registry.members[first].blocked = true);
   const approved = approveAttested(db, options), source = readLegacyMigrationIdentitySource(db);
   mutate(db);
   assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/);
   assert.throws(() => createMigrationReviewCandidate(identitySnapshot(db), options), /identity evidence is unavailable/);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
   assert.deepEqual(readLegacyMigrationIdentitySource(db), source);
  } finally { db.close(); }
 }
});
test('blocked identities still require exact original IDs, native rows and migration bindings', () => {
 const first = 'member@synthetic.example';
 for (const mutate of [
  ...[LEGACY, NATIVE].map(plugin => db => editCustomer(db, plugin, first, data => data.stripeCustomerId = 'cus_changedSynthetic')),
  db => editRegistry(db, registry => registry.members[first].stripeCustomerId = 'cus_changedSynthetic'),
  db => {
   editCustomer(db, NATIVE, first, data => data.stripeCustomerId = 'cus_changedSynthetic');
   editRegistry(db, registry => registry.members[first].stripeCustomerId = 'cus_changedSynthetic');
  },
  db => db.prepare("DELETE FROM _plugin_storage WHERE plugin_id=? AND collection='customers' AND id=?").run(NATIVE, first),
  db => editCustomer(db, NATIVE, first, data => delete data.migrationBinding),
  ...['accountId', 'environment', 'sourceSha256', 'credentialSha256'].map(key => db => {
   const value = key === 'accountId' ? 'acct_other' : key === 'environment' ? 'live' : '0'.repeat(64);
   editCustomer(db, NATIVE, first, data => data.migrationBinding[key] = value);
   editRegistry(db, registry => registry.members[first].migrationBinding[key] = value);
  }),
 ]) {
  const { db, options } = attestedDatabase();
  try {
   editRegistry(db, registry => registry.members[first].blocked = true);
   const approved = approveAttested(db, options);
   mutate(db);
   assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/);
   assert.throws(() => createMigrationReviewCandidate(identitySnapshot(db), options), /identity evidence is unavailable/);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
  } finally { db.close(); }
 }
});
test('registry digest is semantic, byte bounded, required and relational in pure descriptors', () => {
 const { db, options } = attestedDatabase();
 try {
  const s = identitySnapshot(db), approved = approveAttested(db, options);
  const registry = JSON.parse(db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY).value);
  registry.members = Object.fromEntries(Object.entries(registry.members).reverse());
  const json = JSON.stringify(registry, null, 2).padEnd(100_000);
  assert.equal(Buffer.byteLength(json, 'utf8'), 100_000);
  db.prepare('UPDATE options SET value=? WHERE name=?').run(json, REGISTRY);
  assert.deepEqual(readLegacyMigrationIdentityBinding(db), s.identityBinding);
  assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
  for (const field of ['nativeCustomerRegistryBindingsSha256', 'nativeMigrationBindingsSha256', 'expectedNativeMigrationBindingsSha256']) {
   const changed = structuredClone(s);
   changed.identityBinding[field] = '0'.repeat(64);
   assert.throws(() => createMigrationReviewCandidate(changed, options), /unresolved blockers/, field);
   assert.ok(codes(auditLegacyMigration(changed, options)).includes('account_attestation_mismatch'), field);
  }
  // The disposition digest is independently pinned, not equated with identity.
  const changed = structuredClone(s); changed.identityBinding.nativeCustomerRegistrySha256 = '0'.repeat(64);
  assert.equal(createMigrationReviewCandidate(changed, options).identityBinding.nativeCustomerRegistrySha256, '0'.repeat(64));
  assert.equal(auditLegacyMigration(changed, approved).safeToReplaceLegacy, false);
  for (const field of ['nativeCustomerRegistryBindingsSha256', 'nativeCustomerRegistrySha256']) {
   const missing = structuredClone(s); delete missing.identityBinding[field];
   assert.throws(() => createMigrationReviewCandidate(missing, options), /unresolved blockers/);
   const malformed = structuredClone(s); malformed.identityBinding[field] = null;
   assert.throws(() => createMigrationReviewCandidate(malformed, options), /unresolved blockers/);
   const receipt = JSON.parse(approved.reviewedReceiptJson); delete receipt.identityBinding[field];
   assert.equal(auditLegacyMigration(s, { ...options, ...receiptOptions(receipt) }).safeToReplaceLegacy, false);
  }
 } finally { db.close(); }
});
test('registry limit measures UTF-8 bytes of otherwise valid member evidence', () => {
 for (const character of ['e', 'é']) {
  const db = database();
  try {
   const customers = Array.from({ length: 120 }, (_, i) => fixtureCustomer(`${character.repeat(290)}${i}@x.example`, `cus_synthetic${i}`));
   for (const customer of customers) db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(LEGACY, 'customers', customer.email, JSON.stringify(customer));
   const source = readLegacyMigrationIdentitySource(db);
   const migrationBinding = { version: 1, accountId: 'acct_fixture', environment: 'test', sourceSha256: source.sourceSha256, credentialSha256: 'a'.repeat(64) };
   insertNativeCustomers(db, customers.map(customer => ({ ...customer, migrationBinding })));
   const { value } = db.prepare('SELECT value FROM options WHERE name=?').get(REGISTRY);
   assert.ok(value.length < 100_000);
   if (character === 'e') {
    assert.ok(Buffer.byteLength(value, 'utf8') < 100_000);
    assert.equal(readLegacyMigrationIdentityBinding(db).customerCount, 120);
   } else {
    assert.ok(Buffer.byteLength(value, 'utf8') > 100_000);
    assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/);
   }
  } finally { db.close(); }
 }
});
test('externally pinned v2 receipt refuses removal of all retained migration evidence', () => {
 const { db, options } = attestedDatabase();
 try {
  const approved = approveAttested(db, options);
  db.exec('DELETE FROM options; DELETE FROM _plugin_storage');
  assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
 } finally { db.close(); }
});
test('strict opt-in reader refuses duplicate identities, unsupported IDs and malformed in-scope customer rows', () => {
 for (const mutate of [
  ...[LEGACY, NATIVE].map(plugin => db => db.prepare("INSERT INTO _plugin_storage SELECT plugin_id,collection,id,data FROM _plugin_storage WHERE plugin_id=? AND collection='customers' AND id=?").run(plugin, 'member@synthetic.example')),
  ...[LEGACY, NATIVE].map(plugin => db => editCustomer(db, plugin, 'second@synthetic.example', data => data.email = ' MEMBER@SYNTHETIC.EXAMPLE ')),
  ...[LEGACY, NATIVE].map(plugin => db => editCustomer(db, plugin, 'second@synthetic.example', data => data.stripeCustomerId = 'cus_syntheticMember')),
  ...[LEGACY, NATIVE].map(plugin => db => db.prepare("UPDATE _plugin_storage SET id=? WHERE plugin_id=? AND collection='customers' AND id=?").run('cus_unsupportedLookup', plugin, 'member@synthetic.example')),
  db => editCustomer(db, LEGACY, 'member@synthetic.example', data => data.unknown = 'SYNTHETIC_PRIVATE_VALUE'),
  db => editCustomer(db, LEGACY, 'member@synthetic.example', data => delete data.createdAt),
  db => editCustomer(db, LEGACY, 'member@synthetic.example', data => data.updatedAt = 'yesterday'),
  db => editCustomer(db, NATIVE, 'member@synthetic.example', data => data.migrationBinding.extra = true),
  db => db.prepare("UPDATE _plugin_storage SET data=? WHERE plugin_id=? AND collection='customers'").run('{SYNTHETIC_PRIVATE_BROKEN', LEGACY),
 ]) {
  const { db, options } = attestedDatabase();
  try {
   mutate(db);
   assert.throws(() => readLegacyMigrationIdentityBinding(db), { message: 'Migration identity evidence is unavailable or unsupported.' });
   assert.deepEqual(codes(auditLegacyDatabase(db, options)), ['incomplete_snapshot']);
  } finally { db.close(); }
 }
});
test('unrelated new native customers and session changes do not invalidate inherited receipt', () => {
 const { db, options } = attestedDatabase();
 try {
  const approved = approveAttested(db, options), before = readLegacyMigrationIdentityBinding(db);
  const customer = fixtureCustomer('new@synthetic.example', 'cus_newSynthetic');
  db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'customers', customer.email, JSON.stringify(customer));
  db.prepare("UPDATE _plugin_storage SET data=? WHERE collection IN ('sessions','authTokens')").run('SYNTHETIC_CHANGED_TOKEN');
  assert.deepEqual(readLegacyMigrationIdentityBinding(db), before);
  assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
 } finally { db.close(); }
});
test('already pinned v2 receipt survives ordinary native historical shapes and shared non-inherited IDs', () => {
 for (const scenario of ['shared ID', 'missing timestamp', 'non-email key', 'combination']) {
  const { db, options } = attestedDatabase();
  try {
   const approved = approveAttested(db, options), before = readLegacyMigrationIdentityBinding(db);
   const source = readLegacyMigrationIdentitySource(db);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
   const first = fixtureCustomer('ordinary@synthetic.example', 'cus_ordinarySynthetic');
   const second = fixtureCustomer('changed@synthetic.example', first.stripeCustomerId);
   if (['missing timestamp', 'combination'].includes(scenario)) delete first.updatedAt;
   const key = ['non-email key', 'combination'].includes(scenario) ? 'ordinary-lookup-key' : first.email;
   db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'customers', key, JSON.stringify(first));
   if (['shared ID', 'combination'].includes(scenario)) db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'customers', second.email, JSON.stringify(second));
   assert.deepEqual(readLegacyMigrationIdentitySource(db), source, scenario);
   assert.deepEqual(readLegacyMigrationIdentityBinding(db), before, scenario);
   const candidate = createMigrationReviewCandidate(identitySnapshot(db), options);
   assert.equal(receiptOptions(candidate).reviewedReceiptJson, approved.reviewedReceiptJson, scenario);
   assert.equal(receiptOptions(candidate).approvedReceiptSha256, approved.approvedReceiptSha256, scenario);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true, scenario);
  } finally { db.close(); }
 }
});
test('already pinned v2 receipt rejects inherited customer aliases regardless of native key or timestamp', () => {
 for (const unusualKey of [false, true]) for (const missingTimestamp of [false, true]) for (const removeInherited of [false, true]) {
  const { db, options } = attestedDatabase();
  try {
   const approved = approveAttested(db, options);
   const alias = fixtureCustomer('alias@synthetic.example', 'cus_syntheticMember');
   if (missingTimestamp) delete alias.updatedAt;
   if (removeInherited) db.prepare("DELETE FROM _plugin_storage WHERE plugin_id=? AND collection='customers' AND id=?").run(NATIVE, 'member@synthetic.example');
   db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'customers', unusualKey ? 'alias-lookup-key' : alias.email, JSON.stringify(alias));
   assert.throws(() => readLegacyMigrationIdentityBinding(db), /unavailable or unsupported/);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
  } finally { db.close(); }
 }
});
test('inherited lookup keys and unrelated own migrationBinding properties remain strictly validated', () => {
 for (const value of [{}, { email: 'ordinary@synthetic.example' }, { ...fixtureCustomer('ordinary@synthetic.example', 'cus_ordinarySynthetic'), updatedAt: undefined }, null]) {
  const { db, options } = attestedDatabase();
  try {
   const approved = approveAttested(db, options);
   db.prepare("UPDATE _plugin_storage SET data=? WHERE plugin_id=? AND collection='customers' AND id=?").run(JSON.stringify(value), NATIVE, 'member@synthetic.example');
   assert.throws(() => readLegacyMigrationIdentityBinding(db), /unavailable or unsupported/);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
  } finally { db.close(); }
 }
 for (const scenario of ['valid binding', 'null binding', 'empty binding', 'missing timestamp', 'non-email key', 'unknown field']) {
  const { db, options, attestation } = attestedDatabase();
  try {
   const approved = approveAttested(db, options);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true, scenario);
   const customer = { ...fixtureCustomer('bound@synthetic.example', 'cus_boundSynthetic'), migrationBinding: { version: 1, accountId: attestation.accountId, environment: 'test', sourceSha256: attestation.sourceSha256, credentialSha256: attestation.credentialSha256 } };
   if (scenario === 'null binding') customer.migrationBinding = null;
   if (scenario === 'empty binding') customer.migrationBinding = {};
   if (scenario === 'missing timestamp') delete customer.updatedAt;
   if (scenario === 'unknown field') customer.unknown = true;
   db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'customers', scenario === 'non-email key' ? 'bound-lookup-key' : customer.email, JSON.stringify(customer));
   assert.throws(() => readLegacyMigrationIdentityBinding(db), /unavailable or unsupported/);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false, scenario);
  } finally { db.close(); }
 }
});
test('digest validators reject trailing line endings even when all relational values agree', () => {
 const { db, options, attestation } = attestedDatabase();
 try {
  const s = identitySnapshot(db), approved = approveAttested(db, options);
  for (const ending of ['\n', '\r\n']) {
   for (const key of ['approvedReceiptSha256', 'approvedAccountAttestationSha256']) assert.equal(auditLegacyMigration(s, { ...approved, [key]: approved[key] + ending }).safeToReplaceLegacy, false, key);
   // Keep paired and equal descriptor/attestation values consistent, so only
   // lexical validation rejects a 64-character valid prefix plus a line ending.
   const changed = structuredClone(s), evidence = { ...attestation };
   for (const [key, value] of Object.entries(changed.identityBinding)) if (typeof value === 'string') changed.identityBinding[key] = value + ending;
   for (const key of ['sourceSha256', 'coverageSha256', 'nativeCredentialRepresentationSha256', 'credentialSha256']) evidence[key] += ending;
   const malformedOptions = attestationOptions(evidence);
   assert.ok(codes(auditLegacyMigration(changed, malformedOptions)).includes('account_attestation_mismatch'));
   assert.throws(() => createMigrationReviewCandidate(changed, malformedOptions), /unresolved blockers/);
   const v1 = createMigrationReviewCandidate(snapshot());
   v1.selectors = v1.selectors.map(value => value + ending);
   assert.equal(auditLegacyMigration(snapshot(), receiptOptions(v1)).safeToReplaceLegacy, false);
  }
 } finally { db.close(); }
});
test('customer IDs require whole matches in legacy and native rows and registry members', () => {
 for (const validId of ['cus_a', `cus_${'S'.repeat(255)}`]) {
  const customers = [fixtureCustomer('member@synthetic.example', validId), fixtureCustomer('second@synthetic.example', 'cus_syntheticSecond')];
  const fixture = attestedDatabase(undefined, customers);
  try { assert.equal(auditLegacyDatabase(fixture.db, approveAttested(fixture.db, fixture.options)).safeToReplaceLegacy, true); }
  finally { fixture.db.close(); }
  for (const ending of ['\n', '\r\n']) {
   for (const target of [LEGACY, NATIVE, 'registry']) {
    const { db, options } = attestedDatabase(undefined, customers);
    try {
     const approved = approveAttested(db, options);
     if (target === 'registry') editRegistry(db, registry => registry.members['member@synthetic.example'].stripeCustomerId = validId + ending);
     else editCustomer(db, target, 'member@synthetic.example', data => data.stripeCustomerId = validId + ending);
     if (target === LEGACY) assert.throws(() => readLegacyMigrationIdentitySource(db), /unavailable or unsupported/);
     assert.throws(() => readLegacyMigrationIdentityBinding(db), /unavailable or unsupported/);
     assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
    } finally { db.close(); }
   }
  }
 }
});
test('attestation cannot waive current/revision/taxonomy OR mismatches or unknown settings', () => {
 for (const mutate of [
  db => db.prepare('INSERT INTO ec_posts VALUES(?,?,?,?)').run('item', 'paid', '[]', 'SYNTHETIC_BODY'),
  db => db.prepare('INSERT INTO revisions VALUES(?,?,?)').run('posts', 'item', '{"visibility":"paid"}'),
  db => db.prepare('INSERT INTO options VALUES(?,?)').run(`plugin:${LEGACY}:unknown`, 'SYNTHETIC_PRIVATE_UNKNOWN'),
  db => {
   db.exec('ALTER TABLE ec_posts ADD COLUMN translation_group TEXT; CREATE TABLE content_taxonomies(collection TEXT,entry_id TEXT,taxonomy_id TEXT); CREATE TABLE taxonomies(id TEXT,name TEXT,translation_group TEXT)');
   db.prepare('INSERT INTO ec_posts(id,visibility,translation_group) VALUES(?,?,?)').run('item', 'public', 'entry-group');
   db.prepare('INSERT INTO content_taxonomies VALUES(?,?,?)').run('posts', 'entry-group', 'term-group');
   db.prepare('INSERT INTO taxonomies VALUES(?,?,?)').run('term', 'tags', 'term-group');
   db.prepare('INSERT INTO _plugin_storage VALUES(?,?,?,?)').run(NATIVE, 'taxonomy_restrictions', 'tags:term', rule(NATIVE, 'taxonomy_restrictions', { productIds: ['prod_other'] }).data);
  },
 ]) {
  const { db, options } = attestedDatabase();
  try {
   const approved = approveAttested(db, options); mutate(db);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, false);
   assert.throws(() => createMigrationReviewCandidate(identitySnapshot(db), options));
  } finally { db.close(); }
 }
});
test('v2 reports, receipts and opt-in reader expose hashes/counts only; default SELECT remains redacted', () => {
 const { db, options } = attestedDatabase();
 try {
  const calls = [], wrapper = { prepare(sql) { assert.match(sql, /^SELECT /); calls.push(sql); return db.prepare(sql); } };
  const redacted = readLegacyMigrationSnapshot(wrapper);
  assert.equal(Object.hasOwn(redacted, 'identityBinding'), false);
  assert.equal(calls.some(sql => sql.includes("AND collection='customers'")), false);
  assert.equal(calls.some(sql => sql.startsWith('SELECT name, value FROM options')), false);
  assert.equal(redacted.settings.some(row => row.key.includes('migration:customer-bindings')), false);
  assert.equal(calls.some(sql => sql.includes(REGISTRY)), false);
  const defaultCalls = [...calls];
  auditLegacyDatabase(wrapper); assert.deepEqual(calls.slice(defaultCalls.length), defaultCalls);
  const descriptor = readLegacyMigrationIdentityBinding(wrapper, redacted);
  const s = { ...redacted, identityBinding: descriptor };
  const candidate = createMigrationReviewCandidate(s, options);
  const rendered = JSON.stringify([descriptor, candidate, auditLegacyMigration(s, options), auditLegacyDatabase(wrapper, { ...options, ...receiptOptions(candidate) })]);
  for (const privateValue of ['member@', 'second@', 'cus_synthetic', 'prod_fixture', 'acct_fixture', 'SYNTHETIC_ONLY', 'SYNTHETIC_LEGACY', 'SYNTHETIC_PRIVATE', 'SYNTHETIC_PUBLIC', '"environment"']) assert.equal(rendered.includes(privateValue), false, privateValue);
  assert.ok(calls.some(sql => sql.includes("AND collection='customers'")));
  assert.ok(calls.includes(`SELECT name, value FROM options WHERE name='${REGISTRY}' LIMIT 100001`));
  assert.ok(calls.filter(sql => sql.startsWith('SELECT name, value FROM options')).every(sql => !sql.includes('sessions') && !sql.includes('auth')));
 } finally { db.close(); }
});
test('real node:sqlite read-only v2 adapter roundtrip leaves all original source bytes unchanged', () => {
 const directory = mkdtempSync(join(tmpdir(), 'paid-attestation-synthetic-'));
 try {
  const path = join(directory, 'synthetic.db');
  const fixture = attestedDatabase(path); const options = fixture.options; fixture.db.close();
  const before = readFileSync(path), db = new DatabaseSync(path, { readOnly: true });
  try {
   const approved = approveAttested(db, options);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
   assert.equal(auditLegacyDatabase(db, approved).safeToReplaceLegacy, true);
  } finally { db.close(); }
  assert.deepEqual(readFileSync(path), before);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('coverage binds exact product set from mappings and explicit legacy rule products', () => {
 const { db, attestation } = attestedDatabase();
 try {
  const data = JSON.parse(rule(LEGACY, 'restrictions', { productIds: ['prod_zSynthetic', 'prod_aSynthetic'] }).data);
  db.prepare("UPDATE _plugin_storage SET data=? WHERE plugin_id=? AND collection='restrictions'").run(JSON.stringify(data), LEGACY);
  const identity = readLegacyMigrationIdentityBinding(db);
  assert.equal(identity.sourceSha256, attestation.sourceSha256); // Rule semantics remain separately pinned by the receipt.
  assert.equal(identity.productCount, 3);
  assert.equal(identity.coverageSha256, fixtureHash({ products: ['prod_aSynthetic', 'prod_fixture', 'prod_zSynthetic'], customers: [['member@synthetic.example', 'cus_syntheticMember'], ['second@synthetic.example', 'cus_syntheticSecond']] }));
 } finally { db.close(); }
});
test('zero inherited customers still pin native credential representation without inventing a fingerprint', () => {
 const { db, attestation } = attestedDatabase();
 try {
  db.prepare("DELETE FROM _plugin_storage WHERE collection='customers'").run();
  editRegistry(db, registry => registry.members = {});
  const s = identitySnapshot(db), identity = s.identityBinding;
  assert.equal(identity.customerCount, 0); assert.equal(identity.credentialSha256, null);
  assert.equal(identity.nativeMigrationBindingsSha256, fixtureHash([]));
  assert.equal(identity.expectedNativeMigrationBindingsSha256, fixtureHash([]));
  assert.equal(identity.nativeCustomerRegistryBindingsSha256, fixtureHash([]));
  assert.equal(identity.nativeCustomerRegistrySha256, fixtureHash([]));
  const options = attestationOptions({ ...attestation, customerCount: 0, sourceSha256: identity.sourceSha256, coverageSha256: identity.coverageSha256 });
  assert.equal(auditLegacyMigration(s, { ...options, ...receiptOptions(createMigrationReviewCandidate(s, options)) }).safeToReplaceLegacy, true);
  db.prepare('DELETE FROM options WHERE name=?').run(REGISTRY);
  assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/);
  assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false);
 } finally { db.close(); }
});
test('missing account with neither inherited customers nor products cannot establish ownership', () => {
 const { db, attestation } = attestedDatabase();
 try {
  db.prepare("DELETE FROM _plugin_storage WHERE collection IN ('customers','restrictions')").run();
  editRegistry(db, registry => registry.members = {});
  db.prepare('UPDATE options SET value=? WHERE name=?').run('{}', `plugin:${LEGACY}:plan_mappings`);
  const s = identitySnapshot(db), identity = s.identityBinding;
  assert.equal(identity.customerCount + identity.productCount, 0);
  const options = attestationOptions({ ...attestation, customerCount: 0, productCount: 0, sourceSha256: identity.sourceSha256, coverageSha256: identity.coverageSha256 });
  assert.ok(codes(auditLegacyMigration(s, options)).includes('account_attestation_mismatch'));
  assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false);
  assert.throws(() => createMigrationReviewCandidate(s, options), /unresolved blockers/);
 } finally { db.close(); }
});

test('opt-in reads refuse private bounds, bad calendar dates, duplicate settings and consistency drift', () => {
 for (const mutate of [
  db => editCustomer(db, LEGACY, 'member@synthetic.example', data => data.updatedAt = '2026-02-31T12:00:00.000Z'),
  db => db.prepare('UPDATE options SET value=? WHERE name=?').run('x'.repeat(1_000_001), `plugin:${LEGACY}:stripe_secret_key`),
  db => db.prepare('INSERT INTO options SELECT name,value FROM options WHERE name=?').run(`plugin:${NATIVE}:settings:stripeSecretKey`),
 ]) {
  const { db, options } = attestedDatabase();
  try { mutate(db); assert.throws(() => readLegacyMigrationIdentityBinding(db), /identity evidence is unavailable/); assert.equal(auditLegacyDatabase(db, options).safeToReplaceLegacy, false); }
  finally { db.close(); }
 }
 const { db } = attestedDatabase();
 try {
  let versionCalls = 0;
  const wrapper = { prepare(sql) { return sql === 'SELECT data_version FROM pragma_data_version' ? { all() { return [{ data_version: ++versionCalls }]; } } : db.prepare(sql); } };
  assert.throws(() => readLegacyMigrationIdentityBinding(wrapper), /identity evidence is unavailable/);
  assert.throws(() => readLegacyMigrationSnapshot(db, { includeIdentityBinding: 'true' }), /Unsupported snapshot options/);
 } finally { db.close(); }
});
