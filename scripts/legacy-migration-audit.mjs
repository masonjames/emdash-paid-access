// Copyright 2026 Mason James. SPDX-License-Identifier: GPL-2.0-or-later
// Optional offline migration input only. Never imports or calls the legacy plugin.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEGACY = 'restrict-with-stripe';
const NATIVE = 'paid-access';
const LIMIT = 100_000;
const PAID_SLUGS = new Set(['default-product', 'content-personall-ai']);
const PRIVATE_COLLECTIONS = new Set(['customers', 'sessions', 'authTokens', 'auth_tokens']);
const LEGACY_SETTINGS = new Set(['plan_mappings', 'show_excerpts', 'stripe_environment', 'stripe_account_id', 'stripe_secret_key', 'stripe_publishable_key']);
const SECRET_SETTINGS = new Set(['stripe_secret_key', 'stripe_publishable_key', 'stripeSecretKey', 'stripePublishableKey']);
const NATIVE_SETTINGS = new Set(['humansMode', 'humansPlans', 'stripeEnvironment', 'stripeAccountId', 'state:legacyPluginPresent']);
const ACTIONS = {
 migration_receipt_mismatch: 'Repeat offline review: the trusted receipt is absent, malformed, or differs from the current inherited access configuration.',
 legacy_migration_review_required: 'Review an explicit offline migration and retain source records and approve a pinned migration receipt after preserving restrictions; this audit never imports or authorizes migration.',
 incomplete_snapshot: 'Use a complete offline SQLite copy with the expected schema and repeat the audit.',
 unknown_legacy_record: 'Review unsupported legacy storage or settings before removing the legacy runtime.',
 invalid_record: 'Repair malformed or ambiguous access metadata in a reviewed migration.',
 free_member_semantics: 'Review free-member access separately; no automatic entitlement conversion is supported.',
 protected_content_metadata: 'Review imported visibility and product metadata and replace it with explicit native rules.',
 missing_native_rule: 'Create and review native rules for every legacy selector before replacement.',
 changed_native_rule: 'Preserve the exact product requirements and deny agent purchase bypass with a native members-only rule.',
 unresolved_plan: 'Configure and review explicit legacy and native Stripe product mappings.',
 native_configuration: 'Configure independent native Stripe mode with the same reviewed account and environment.',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const strings = value => value === undefined || Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const sorted = values => [...new Set(values)].sort();
const equal = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

/** Pure, deterministic, count-only report. Does not authorize import or deployment. */
function analyze(snapshot, scope) {
 let review = null;
 const counts = { legacyArtifacts: 0, nativeCredentialSettings: 0, legacyRules: 0, nativeRules: 0, preservedRules: 0, legacyCustomers: 0, legacySessions: 0, legacyAuthTokens: 0, legacyCredentialSettings: 0, contentMetadata: 0 };
 const issues = new Map();
 const block = (code, count = 1) => issues.set(code, (issues.get(code) ?? 0) + count);
 const finish = () => ({ review, report: { safeToReplaceLegacy: issues.size === 0, counts, blockers: [...issues].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count, action: ACTIONS[code] })) } });
 if (!object(snapshot) || snapshot.complete !== true || !Array.isArray(snapshot.storage) || !Array.isArray(snapshot.settings) || !Array.isArray(snapshot.contentMetadata) || [snapshot.storage, snapshot.settings, snapshot.contentMetadata].some(rows => rows.length > LIMIT)) {
  block('incomplete_snapshot'); return finish();
 }
 const legacySettings = {}, nativeSettings = {}, seenSettings = new Set();
 for (const row of snapshot.settings) {
  if (!object(row) || ![LEGACY, NATIVE].includes(row.plugin) || !text(row.key)) { block('invalid_record'); continue; }
  if (row.plugin === LEGACY) counts.legacyArtifacts++;
  const identity = `${row.plugin}:${row.key}`;
  if (seenSettings.has(identity)) { block('invalid_record'); continue; }
  seenSettings.add(identity);
  if (SECRET_SETTINGS.has(row.key)) { if (row.plugin === LEGACY) counts.legacyCredentialSettings++; else if (row.key === 'stripeSecretKey' && row.present === true) counts.nativeCredentialSettings++; continue; }
  if (row.plugin === LEGACY && !LEGACY_SETTINGS.has(row.key)) { block('unknown_legacy_record'); continue; }
  if (row.plugin === NATIVE && !NATIVE_SETTINGS.has(row.key)) continue;
  try { (row.plugin === LEGACY ? legacySettings : nativeSettings)[row.key] = decode(row.value); }
  catch { block('invalid_record'); }
 }
 const mappings = legacySettings.plan_mappings ?? {};
 if (!object(mappings) || Object.entries(mappings).some(([key, value]) => !PAID_SLUGS.has(key) || value !== null && !text(value))) block('unresolved_plan');
 const plans = new Map();
 const configuredPlans = nativeSettings.humansPlans ?? [];
 if (!Array.isArray(configuredPlans)) block('native_configuration');
 else for (const plan of configuredPlans) {
  if (!object(plan) || !text(plan.slug) || !text(plan.name) || !Array.isArray(plan.grantsVisibility) || !strings(plan.grantsVisibility) || plans.has(plan.slug) || plan.stripeProductId != null && plan.stripeProductId !== '' && !text(plan.stripeProductId)) { block('native_configuration'); continue; }
  // Unlinked native catalog drafts are valid; a rule using one fails below.
  plans.set(plan.slug, plan.stripeProductId || null);
 }
 const rules = { [LEGACY]: [], [NATIVE]: [] }, seenRules = new Set();
 for (const row of snapshot.storage) {
  if (!object(row) || ![LEGACY, NATIVE].includes(row.plugin) || !text(row.collection)) { block('invalid_record'); continue; }
  if (row.plugin === LEGACY) counts.legacyArtifacts++;
  if (PRIVATE_COLLECTIONS.has(row.collection)) {
   if (row.plugin === LEGACY) counts[row.collection === 'customers' ? 'legacyCustomers' : row.collection === 'sessions' ? 'legacySessions' : 'legacyAuthTokens']++;
   continue; // Never inspect identities, tokens, sessions or credentials.
  }
  const taxonomy = ['taxonomyRestrictions', 'taxonomy_restrictions'].includes(row.collection);
  if (row.collection !== 'restrictions' && !taxonomy) {
   if (row.plugin === LEGACY) block('unknown_legacy_record');
   continue;
  }
  if (row.plugin === NATIVE && row.collection === 'taxonomyRestrictions') { block('invalid_record'); continue; }
  counts[row.plugin === LEGACY ? 'legacyRules' : 'nativeRules']++;
  let data;
  try { data = decode(row.data); } catch { block('invalid_record'); continue; }
  const selector = taxonomy ? ['taxonomyName', 'termId'] : ['collectionSlug', 'contentId'];
  const allowed = new Set([...selector, 'slug', 'title', 'requiredPlanSlugs', 'productIds', 'source', 'createdAt', 'updatedAt', ...(row.plugin === NATIVE ? ['policy', 'agentPrice', 'passEligible'] : [])]);
  if (!object(data) || Object.keys(data).some(key => !allowed.has(key)) || !selector.every(key => text(data[key])) || !strings(data.requiredPlanSlugs) || !strings(data.productIds) || !text(row.id) || row.plugin === NATIVE && data.passEligible !== undefined && typeof data.passEligible !== 'boolean') { block('invalid_record'); continue; }
  const key = `${data[selector[0]]}:${data[selector[1]]}`;
  // Preserve the actual lookup key, including historical slug-keyed rules.
  if (row.id !== key && (taxonomy || !text(data.slug) || row.id !== `${data.collectionSlug}:${data.slug}`)) { block('invalid_record'); continue; }
  const identity = `${row.plugin}:${taxonomy ? 'taxonomy' : 'entry'}:${row.id}`;
  if (seenRules.has(identity)) { block('invalid_record'); continue; }
  seenRules.add(identity);
  const slugs = data.requiredPlanSlugs ?? [];
  if (slugs.includes('free')) { block('free_member_semantics'); continue; }
  const products = [...(data.productIds ?? [])];
  let unresolved = false;
  for (const slug of slugs) {
   const product = row.plugin === LEGACY ? (PAID_SLUGS.has(slug) && object(mappings) ? mappings[slug] : null) : plans.get(slug);
   if (!text(product)) unresolved = true; else products.push(product);
  }
  if (unresolved || products.length === 0 && row.plugin === LEGACY) { block('unresolved_plan'); continue; }
  rules[row.plugin].push({ key: `${taxonomy ? 'taxonomy' : 'entry'}:${row.id}`, selector: selector.map(k => data[k]), products: sorted(products), slugs: sorted(slugs), policy: data.policy, agentPrice: data.agentPrice, passEligible: data.passEligible });
 }
 for (const legacy of rules[LEGACY]) {
  const native = rules[NATIVE].find(rule => rule.key === legacy.key);
  if (!native) block('missing_native_rule');
  else if (native.policy !== 'members-only' || native.agentPrice != null && native.agentPrice !== '' || native.passEligible === true || JSON.stringify(native.selector) !== JSON.stringify(legacy.selector) || !equal(native.products, legacy.products)) block('changed_native_rule');
  else counts.preservedRules++;
 }
 if (counts.legacyArtifacts > 0) block('legacy_migration_review_required');
 const nativeConfigured = nativeSettings.humansMode === 'stripe' && text(nativeSettings.stripeAccountId) && ['live', 'test', 'sandbox'].includes(nativeSettings.stripeEnvironment) && counts.nativeCredentialSettings === 1;
 if (nativeSettings['state:legacyPluginPresent'] !== undefined && nativeSettings['state:legacyPluginPresent'] !== false || ['delegate', 'migration-required'].includes(nativeSettings.humansMode)) block('native_configuration');
 if (counts.legacyArtifacts > 0 && !nativeConfigured) block('native_configuration');
 if (counts.legacyArtifacts > 0) {
  const legacyEnvironment = legacySettings.stripe_environment ?? 'live';
  const nativeEnvironment = nativeSettings.stripeEnvironment;
  const normalizeEnvironment = value => ['test', 'sandbox'].includes(value) ? 'test' : value === 'live' ? 'live' : null;
  if (nativeSettings.humansMode !== 'stripe' || !text(legacySettings.stripe_account_id) || legacySettings.stripe_account_id !== nativeSettings.stripeAccountId || !normalizeEnvironment(legacyEnvironment) || normalizeEnvironment(legacyEnvironment) !== normalizeEnvironment(nativeEnvironment)) block('native_configuration');
 }
 const entries = new Map(), terms = snapshot.entryTerms ?? [];
 if (!Array.isArray(terms) || terms.length > LIMIT || terms.some(term => !object(term) || !['collection', 'entryId', 'taxonomyName', 'termId'].every(key => text(term[key])))) { block('incomplete_snapshot'); return finish(); }
 const entryKey = row => `entry:${row.collection}:${row.id}`;
 const metadata = [];
 for (const row of snapshot.contentMetadata) {
  counts.contentMetadata++;
  if (!object(row)) { block('invalid_record'); continue; }
  let slugs;
  try { slugs = typeof row.ghost_product_slugs === 'string' ? JSON.parse(row.ghost_product_slugs) : row.ghost_product_slugs; } catch { block('invalid_record'); continue; }
  if (slugs != null && !strings(slugs)) { block('invalid_record'); continue; }
  if (row.visibility === 'free') { block('free_member_semantics'); continue; }
  // Historical ghost metadata used 'free' as nonpaid classification. This does
  // not create a free membership entitlement or waive explicit rule semantics.
  slugs = slugs?.filter(slug => slug !== 'free');
  // Explicit public visibility historically ignored recognized product labels.
  // Unknown labels still require review rather than being silently discarded.
  if (row.visibility === 'public') slugs = slugs?.filter(slug => !PAID_SLUGS.has(slug));
  if (row.unsupported === true || row.visibility != null && !['public', 'members', 'paid'].includes(row.visibility)) { block('protected_content_metadata'); continue; }
  const protectedMetadata = row.visibility != null && row.visibility !== 'public' || (slugs?.length ?? 0) > 0;
  if (!text(row.collection) || !text(row.id)) { if (protectedMetadata) block('protected_content_metadata'); continue; }
  if (row.slug != null && !text(row.slug)) { block('invalid_record'); continue; }
  const key = entryKey(row);
  if (!row.revision) {
   if (entries.has(key)) block('invalid_record');
   entries.set(key, row);
  }
  const required = sorted([...(slugs ?? []), ...(row.visibility === 'members' ? ['default-product', 'content-personall-ai'] : row.visibility === 'paid' ? ['content-personall-ai'] : [])]);
  if (required.some(slug => !PAID_SLUGS.has(slug) || !text(plans.get(slug)) || counts.legacyArtifacts > 0 && (!object(mappings) || mappings[slug] !== plans.get(slug)))) block('unresolved_plan');
  metadata.push({ key, row, protectedMetadata, required, products: sorted(required.map(slug => plans.get(slug)).filter(text)) });
 }
 const ruleKeys = row => new Set([entryKey(row), ...(row.slug ? [`entry:${row.collection}:${row.slug}`] : []), ...terms.filter(term => term.collection === row.collection && term.entryId === row.id).map(term => `taxonomy:${term.taxonomyName}:${term.termId}`)]);
 const matching = (row, plugin) => { const keys = ruleKeys(row); return rules[plugin].filter(rule => keys.has(rule.key)); };
 const gated = rule => ['members', 'members-only'].includes(rule.policy);
 const strict = rule => rule.policy === 'members-only' && (rule.agentPrice == null || rule.agentPrice === '') && rule.passEligible !== true;
 const protectedEntries = new Set();
 for (const item of metadata) {
  if (!item.protectedMetadata) continue;
  protectedEntries.add(item.key);
  if (!nativeConfigured) block('native_configuration');
  const row = entries.get(item.key);
  if (!row) { block('protected_content_metadata'); continue; }
  const direct = rules[NATIVE].find(rule => rule.key === item.key);
  if (!direct || !strict(direct) || direct.selector[0] !== row.collection || direct.selector[1] !== row.id) { block('missing_native_rule'); continue; }
  const expected = sorted([...item.products, ...matching(row, LEGACY).flatMap(rule => rule.products)]);
  const effective = matching(row, NATIVE).filter(gated);
  if (!effective.every(strict) || !equal(effective.flatMap(rule => rule.products), expected)) block('changed_native_rule');
 }
 // An additional slug or taxonomy grant must not broaden a retained legacy rule.
 for (const row of entries.values()) {
  const inherited = matching(row, LEGACY);
  if (!inherited.length) continue;
  const expected = [...inherited.flatMap(rule => rule.products), ...metadata.filter(item => item.key === entryKey(row)).flatMap(item => item.products)];
  const effective = matching(row, NATIVE).filter(gated);
  if (!effective.every(strict) || !equal(effective.flatMap(rule => rule.products), expected)) block('changed_native_rule');
 }
 const requiredKeys = new Set(rules[LEGACY].map(rule => rule.key));
 for (const row of entries.values()) if (matching(row, LEGACY).length) requiredKeys.add(entryKey(row));
 const allKeys = new Set([...requiredKeys, ...protectedEntries]);
 const requested = scope ?? sorted([...allKeys].map(hash));
 const requiredHashes = [...requiredKeys].map(hash);
 if (requiredHashes.some(key => !requested.includes(key))) block('migration_receipt_mismatch');
 const selected = new Set([...allKeys, ...entries.keys()].filter(key => requested.includes(hash(key))));
 // Receipt selectors are opaque hashes; missing previously reviewed content is drift.
 if (selected.size !== requested.length) block('migration_receipt_mismatch');
 const relevantNative = new Map();
 for (const rule of rules[NATIVE]) if (selected.has(rule.key)) relevantNative.set(rule.key, rule);
 for (const row of entries.values()) if (selected.has(entryKey(row))) for (const rule of matching(row, NATIVE)) relevantNative.set(rule.key, rule);
 const relevantSlugs = sorted([...rules[LEGACY].flatMap(rule => rule.slugs), ...[...relevantNative.values()].flatMap(rule => rule.slugs), ...metadata.filter(item => selected.has(item.key)).flatMap(item => item.required)]);
 review = {
  kind: 'paid-access-reviewed-legacy-migration', version: 1, selectors: requested,
  sourceSha256: hash({ settings: legacySettings, rules: ordered(rules[LEGACY]), counts: Object.fromEntries(Object.entries(counts).filter(([key]) => key.startsWith('legacy'))) }),
  nativeSha256: hash({ rules: ordered([...relevantNative.values()]), plans: relevantSlugs.map(slug => [slug, plans.get(slug)]), mode: nativeSettings.humansMode, account: nativeSettings.stripeAccountId, environment: nativeSettings.stripeEnvironment, credentialPresent: counts.nativeCredentialSettings === 1 }),
  metadataSha256: hash({ entries: ordered([...entries].filter(([key]) => selected.has(key)).map(([key,row]) => [key,row.slug ?? null])), metadata: sorted(metadata.filter(item => selected.has(item.key)).map(item => canonical({ key: item.key, visibility: item.row.visibility ?? null, slugs: item.required }))), terms: ordered(terms.filter(term => selected.has(`entry:${term.collection}:${term.entryId}`))) }),
  counts: { legacyArtifacts: counts.legacyArtifacts, legacyRules: counts.legacyRules, selectors: requested.length, nativeRules: relevantNative.size },
 };

 return finish();
}

function canonical(value) {
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
 return JSON.stringify(value);
}
const ordered = values => [...values].sort((a, b) => canonical(a).localeCompare(canonical(b)));
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const migrationReceiptSha256 = json => { if (typeof json !== 'string') throw new Error('Receipt must be exact UTF-8 JSON text.'); return createHash('sha256').update(json, 'utf8').digest('hex'); };
const receiptShape = receipt => object(receipt) && receipt.kind === 'paid-access-reviewed-legacy-migration' && receipt.version === 1 && Array.isArray(receipt.selectors) && receipt.selectors.length <= LIMIT && receipt.selectors.every(value => /^[a-f0-9]{64}$/.test(value)) && equal(receipt.selectors, sorted(receipt.selectors)) && new Set(receipt.selectors).size === receipt.selectors.length;

/** Receipt and digest must come from independently reviewed deployment configuration,
 * never plugin storage or automatic preparation. Substantive blockers cannot be waived. */
export function auditLegacyMigration(snapshot, options = {}) {
 const { reviewedReceiptJson, approvedReceiptSha256 } = options;
 const supplied = Object.keys(options).length > 0;
 let reviewedReceipt;
 try { if (typeof reviewedReceiptJson === 'string' && reviewedReceiptJson.length <= 16_000_000) reviewedReceipt = JSON.parse(reviewedReceiptJson); } catch { /* Sanitized mismatch below. */ }
 const valid = receiptShape(reviewedReceipt) && typeof approvedReceiptSha256 === 'string' && /^[a-f0-9]{64}$/.test(approvedReceiptSha256) && migrationReceiptSha256(reviewedReceiptJson) === approvedReceiptSha256;
 const { report, review } = analyze(snapshot, valid ? reviewedReceipt.selectors : undefined);
 if (supplied && (!valid || canonical(review) !== canonical(reviewedReceipt))) report.blockers.push({ code: 'migration_receipt_mismatch', count: 1, action: ACTIONS.migration_receipt_mismatch });
 else if (valid && review) report.blockers = report.blockers.filter(row => row.code !== 'legacy_migration_review_required');
 report.safeToReplaceLegacy = report.blockers.length === 0;
 return report;
}

/** Preparation is not approval. This returns only hashes/counts for external review. */
export function createMigrationReviewCandidate(snapshot) {
 const { report, review } = analyze(snapshot);
 if (!review || !report.counts.legacyArtifacts || report.blockers.some(row => row.code !== 'legacy_migration_review_required')) throw new Error('Migration protection has unresolved blockers.');
 return review;
}

/** Caller supplies its existing better-sqlite3 connection. Only SELECTs are issued. */
export function readLegacyMigrationSnapshot(db) {
 const rows = (sql, ...parameters) => {
  const result = db.prepare(sql).all(...parameters);
  if (result.length > LIMIT) throw new Error('Audit exceeds supported bound.');
  return result;
 };
 const dataVersion = rows('SELECT data_version FROM pragma_data_version')[0]?.data_version;
 if (!Number.isInteger(dataVersion)) throw new Error('Missing SQLite consistency marker.');
 const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
 if (!tables.has('_plugin_storage') || !tables.has('options')) throw new Error('Incomplete migration schema.');
 const storage = rows("SELECT plugin_id AS plugin, collection, CASE WHEN collection IN ('restrictions','taxonomyRestrictions','taxonomy_restrictions') THEN id ELSE NULL END AS id, CASE WHEN collection IN ('restrictions','taxonomyRestrictions','taxonomy_restrictions') THEN data ELSE NULL END AS data FROM _plugin_storage WHERE plugin_id IN ('restrict-with-stripe','paid-access') LIMIT 100001");
 // Secret values are never selected, even into process memory.
 const settings = rows("SELECT name, CASE WHEN name IN ('plugin:restrict-with-stripe:plan_mappings','plugin:restrict-with-stripe:show_excerpts','plugin:restrict-with-stripe:stripe_environment','plugin:restrict-with-stripe:stripe_account_id','plugin:paid-access:settings:humansMode','plugin:paid-access:settings:humansPlans','plugin:paid-access:settings:stripeEnvironment','plugin:paid-access:settings:stripeAccountId','plugin:paid-access:state:legacyPluginPresent') THEN value ELSE NULL END AS value, CASE WHEN name='plugin:paid-access:settings:stripeSecretKey' AND value IS NOT NULL AND value NOT IN ('null','\"\"','') THEN 1 ELSE 0 END AS present FROM options WHERE name LIKE 'plugin:restrict-with-stripe:%' OR name LIKE 'plugin:paid-access:settings:%' OR name='plugin:paid-access:state:legacyPluginPresent' LIMIT 100001").map(row => {
  const legacy = row.name.startsWith(`plugin:${LEGACY}:`);
  return { plugin: legacy ? LEGACY : NATIVE, key: row.name === 'plugin:paid-access:state:legacyPluginPresent' ? 'state:legacyPluginPresent' : row.name.slice((legacy ? `plugin:${LEGACY}:` : `plugin:${NATIVE}:settings:`).length), value: row.value, present: row.present === 1 };
 });
 const contentMetadata = [], entryTerms = [];
 if (tables.has('content_taxonomies') !== tables.has('taxonomies')) throw new Error('Incomplete taxonomy schema.');
 for (const table of tables) {
  if (!table.startsWith('ec_')) continue;
  if (!/^ec_[a-z][a-z0-9_]*$/.test(table)) throw new Error('Unsupported collection table.');
  const columns = rows('SELECT name FROM pragma_table_info(?)', table).map(row => row.name);
  const metadata = columns.filter(column => ['visibility', 'ghost_product_slugs'].includes(column));
  const unsupported = columns.some(column => /(?:membership|restriction|access_policy|ghost_visibility)/i.test(column));
  if (unsupported) contentMetadata.push({ unsupported: true });
  if (!columns.includes('id')) throw new Error('Missing content identity.');
  const identity = ['id', ...columns.filter(column => ['slug', 'translation_group'].includes(column))];
  const collection = table.slice(3);
  const entries = rows(`SELECT ${[...identity, ...metadata].map(column => `"${column}"`).join(',')} FROM "${table}" LIMIT 100001`);
  contentMetadata.push(...entries.map(row => ({ ...row, collection })));
  if (tables.has('content_taxonomies')) {
   if (!columns.includes('translation_group')) throw new Error('Missing taxonomy identity.');
   entryTerms.push(...rows(`SELECT ? AS collection, e.id AS entryId, t.name AS taxonomyName, t.id AS termId FROM "${table}" e JOIN content_taxonomies ct ON ct.collection=? AND ct.entry_id=e.translation_group JOIN taxonomies t ON t.translation_group=ct.taxonomy_id LIMIT 100001`, collection, collection));
  }
 }
 // Historical snapshots can be restored later; do not silently discard their access semantics.
 if (tables.has('revisions')) contentMetadata.push(...rows("SELECT collection, entry_id AS id, 1 AS revision, json_extract(data,'$.visibility') AS visibility, json_extract(data,'$.ghost_product_slugs') AS ghost_product_slugs FROM revisions WHERE json_extract(data,'$.visibility') IS NOT NULL OR json_extract(data,'$.ghost_product_slugs') IS NOT NULL LIMIT 100001"));
 if (rows('SELECT data_version FROM pragma_data_version')[0]?.data_version !== dataVersion) throw new Error('Database changed during audit.');
 return { complete: true, storage, settings, contentMetadata, entryTerms };
}

export function auditLegacyDatabase(db, options) {
 try { return auditLegacyMigration(readLegacyMigrationSnapshot(db), options); }
 catch { return auditLegacyMigration(null); } // Never expose SQL/data in errors.
}

export async function runCli(argv = process.argv.slice(2)) {
 const prepare = argv.length === 3 && argv[2] === '--prepare-review';
 if ((!prepare && argv.length !== 2) || argv[0] !== '--offline-database' || !isAbsolute(argv[1])) throw new Error('Use --offline-database /absolute/path/to/offline-copy.db');
 const path = argv[1];
 if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path).startsWith('/data/') || existsSync(`${path}-wal`) || existsSync(`${path}-shm`) || existsSync(`${path}-journal`)) throw new Error('Use a closed, standalone offline database copy.');
 const { default: Database } = await import('better-sqlite3');
 const db = new Database(path, { readonly: true, fileMustExist: true });
 try { const snapshot = readLegacyMigrationSnapshot(db); const report = auditLegacyMigration(snapshot); const output = prepare ? { audit: report, reviewCandidate: createMigrationReviewCandidate(snapshot) } : report; console.log(JSON.stringify(output, null, 2)); return report.safeToReplaceLegacy ? 0 : 2; }
 finally { db.close(); }
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
 try { process.exitCode = await runCli(); }
 catch { console.error('Offline migration audit refused. Supply a closed SQLite copy; no data was changed.'); process.exitCode = 2; }
}
