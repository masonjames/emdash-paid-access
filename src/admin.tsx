// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import React, { useCallback, useEffect, useMemo, useState } from "react";

import { probeLegacyPluginFromBrowser } from "./coexistence.js";
import type { HumanPlan } from "./plans.js";
import type { AgentSettings, HumanSettings } from "./types.js";

const API = "/_emdash/api/plugins/paid-access";
const HEADERS = { "Content-Type": "application/json", "X-EmDash-Request": "1" };

type SettingsState = {
	agents: AgentSettings;
	humans: HumanSettings;
	stripeSecretKeyMasked: string;
	stripePublishableKey: string;
	stripeAccountId: string;
	stripeEnvironment: "live" | "test";
	showExcerpts: boolean;
	emailConfigured: boolean;
	isConfigured: boolean;
};

type RestrictionRecord = {
	id: string;
	data: {
		contentId: string;
		collectionSlug: string;
		slug?: string | null;
		title?: string | null;
		requiredPlanSlugs?: string[];
		productIds?: string[];
	};
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		...options,
		headers: { ...HEADERS, ...(options?.headers || {}) },
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(payload?.error?.message || "Request failed.");
	return (payload?.data ?? payload) as T;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section style={{ marginBottom: 28 }}>
			<h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{title}</h3>
			{children}
		</section>
	);
}

function FieldLabel({ children }: { children: React.ReactNode }) {
	return <span style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{children}</span>;
}

function SettingsPage() {
	const [settings, setSettings] = useState<SettingsState | null>(null);
	const [plansJson, setPlansJson] = useState("[]");
	const [secretKey, setSecretKey] = useState("");
	const [legacyPresent, setLegacyPresent] = useState(false);
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		const loaded = await api<SettingsState>("/admin/settings");
		setSettings(loaded);
		setPlansJson(JSON.stringify(loaded.humans.plans, null, 2));
	}, []);

	useEffect(() => {
		load().catch((error: Error) => setMessage(error.message));
		probeLegacyPluginFromBrowser().then(setLegacyPresent).catch(() => setLegacyPresent(true));
	}, [load]);

	async function save() {
		if (!settings) return;
		setSaving(true);
		setMessage("");
		try {
			const plans = JSON.parse(plansJson) as HumanPlan[];
			const result = await api<{ ok: boolean; error?: string }>("/admin/settings", {
				method: "POST",
				body: JSON.stringify({
					agents: settings.agents,
					humans: { ...settings.humans, plans },
					legacyPluginPresent: legacyPresent,
					stripeSecretKey: secretKey || settings.stripeSecretKeyMasked,
					stripePublishableKey: settings.stripePublishableKey,
					stripeAccountId: settings.stripeAccountId,
					stripeEnvironment: settings.stripeEnvironment,
					showExcerpts: settings.showExcerpts,
				}),
			});
			if (!result.ok) throw new Error(result.error || "Unable to save settings.");
			setSecretKey("");
			await load();
			setMessage("Settings saved.");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unable to save settings.");
		} finally {
			setSaving(false);
		}
	}

	if (!settings) return <p>Loading…</p>;

	return (
		<div style={{ maxWidth: 760, padding: 16 }}>
			<h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Paid Access Settings</h2>
			{legacyPresent && (
				<p style={warningStyle}>The legacy membership plugin is active. Human Stripe mode is unavailable; use delegate mode.</p>
			)}

			<Section title="Modules">
				<div style={gridStyle}>
					<label>
						<FieldLabel>Agents</FieldLabel>
						<select value={settings.agents.mode} onChange={(event) => setSettings({ ...settings, agents: { ...settings.agents, mode: event.target.value as AgentSettings["mode"] } })} style={inputStyle}>
							<option value="off">Off</option><option value="tokens-only">Tokens only</option><option value="paid">Paid</option>
						</select>
					</label>
					<label>
						<FieldLabel>Humans</FieldLabel>
						<select value={settings.humans.mode} onChange={(event) => setSettings({ ...settings, humans: { ...settings.humans, mode: event.target.value as HumanSettings["mode"] } })} style={inputStyle}>
							<option value="off">Off</option><option value="delegate">Delegate</option><option value="stripe" disabled={legacyPresent}>Stripe</option>
						</select>
					</label>
				</div>
			</Section>

			<Section title="Agent payments">
				<div style={gridStyle}>
					<label><FieldLabel>Rail</FieldLabel><select value={settings.agents.rail} onChange={(event) => setSettings({ ...settings, agents: { ...settings.agents, rail: event.target.value as AgentSettings["rail"] } })} style={inputStyle}><option value="origin-x402">Origin x402</option><option value="gateway">Cloudflare Gateway</option></select></label>
					<label><FieldLabel>Network</FieldLabel><select value={settings.agents.network} onChange={(event) => setSettings({ ...settings, agents: { ...settings.agents, network: event.target.value as AgentSettings["network"] } })} style={inputStyle}><option value="">Choose a network</option><option value="eip155:84532">Base Sepolia</option><option value="eip155:8453">Base</option></select></label>
				</div>
				<label><FieldLabel>Pay-to EVM address</FieldLabel><input value={settings.agents.payTo} onChange={(event) => setSettings({ ...settings, agents: { ...settings.agents, payTo: event.target.value } })} style={inputStyle} /></label>
			</Section>

			<Section title="Human memberships">
				<div style={gridStyle}>
					<label><FieldLabel>Stripe secret key</FieldLabel><input type="password" value={secretKey} placeholder={settings.stripeSecretKeyMasked || "sk_test_…"} onChange={(event) => setSecretKey(event.target.value)} style={inputStyle} /></label>
					<label><FieldLabel>Environment</FieldLabel><select value={settings.stripeEnvironment} onChange={(event) => setSettings({ ...settings, stripeEnvironment: event.target.value as "live" | "test" })} style={inputStyle}><option value="test">Test</option><option value="live">Live</option></select></label>
				</div>
				<label><FieldLabel>Plans (JSON)</FieldLabel><textarea rows={12} value={plansJson} onChange={(event) => setPlansJson(event.target.value)} style={inputStyle} /></label>
				<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}><input type="checkbox" checked={settings.showExcerpts} onChange={(event) => setSettings({ ...settings, showExcerpts: event.target.checked })} />Show excerpts on locked content</label>
				<p style={captionText}>Email provider: <strong>{settings.emailConfigured ? "ready" : "not ready"}</strong></p>
			</Section>

			<button type="button" onClick={save} disabled={saving} style={buttonStyle}>{saving ? "Saving…" : "Save settings"}</button>
			{message && <p style={{ ...helpText, marginTop: 12 }}>{message}</p>}
		</div>
	);
}

function RulesPage() {
	const [restrictions, setRestrictions] = useState<RestrictionRecord[]>([]);
	const [plans, setPlans] = useState<HumanPlan[]>([]);
	const [message, setMessage] = useState("");
	const [draft, setDraft] = useState({ collectionSlug: "posts", contentId: "", slug: "", title: "", requiredPlanSlugs: [] as string[] });

	const load = useCallback(async () => {
		const [settings, result] = await Promise.all([
			api<SettingsState>("/admin/settings"),
			api<{ items: RestrictionRecord[] }>("/admin/restrictions"),
		]);
		setPlans(settings.humans.plans);
		setRestrictions(result.items || []);
	}, []);

	useEffect(() => { load().catch((error: Error) => setMessage(error.message)); }, [load]);
	const planLabels = useMemo(() => Object.fromEntries(plans.map((plan) => [plan.slug, plan.name])), [plans]);

	async function saveRule() {
		if (!draft.collectionSlug || !draft.contentId) return setMessage("Collection slug and content ID are required.");
		const result = await api<{ ok: boolean; error?: string }>("/admin/restrictions", { method: "POST", body: JSON.stringify(draft) });
		if (!result.ok) return setMessage(result.error || "Unable to save rule.");
		setDraft({ collectionSlug: "posts", contentId: "", slug: "", title: "", requiredPlanSlugs: [] });
		await load();
		setMessage("Rule saved.");
	}

	return (
		<div style={{ maxWidth: 760, padding: 16 }}>
			<h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Paid Access Rules</h2>
			<Section title="Add or update a rule">
				<div style={gridStyle}>
					<label><FieldLabel>Collection slug</FieldLabel><input value={draft.collectionSlug} onChange={(event) => setDraft({ ...draft, collectionSlug: event.target.value })} style={inputStyle} /></label>
					<label><FieldLabel>Content ID</FieldLabel><input value={draft.contentId} onChange={(event) => setDraft({ ...draft, contentId: event.target.value })} style={inputStyle} /></label>
					<label><FieldLabel>Slug (optional)</FieldLabel><input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} style={inputStyle} /></label>
					<label><FieldLabel>Title (optional)</FieldLabel><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} style={inputStyle} /></label>
				</div>
				<div style={{ display: "grid", gap: 8, marginTop: 12 }}>{plans.map((plan) => <label key={plan.slug}><input type="checkbox" checked={draft.requiredPlanSlugs.includes(plan.slug)} onChange={(event) => setDraft({ ...draft, requiredPlanSlugs: event.target.checked ? [...draft.requiredPlanSlugs, plan.slug] : draft.requiredPlanSlugs.filter((slug) => slug !== plan.slug) })} /> {plan.name}</label>)}</div>
				<button type="button" onClick={() => saveRule().catch((error: Error) => setMessage(error.message))} style={{ ...buttonStyle, marginTop: 16 }}>Save rule</button>
			</Section>
			<Section title="Current rules">
				{restrictions.length === 0 ? <p style={helpText}>No rules saved.</p> : restrictions.map((item) => <div key={item.id} style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}><strong>{item.data.title || `${item.data.collectionSlug}/${item.data.slug || item.data.contentId}`}</strong><p style={captionText}>{(item.data.requiredPlanSlugs || []).map((slug) => planLabels[slug] || slug).join(", ") || "No plans selected"}</p></div>)}
			</Section>
			{message && <p style={helpText}>{message}</p>}
		</div>
	);
}

function OverviewWidget() {
	const [settings, setSettings] = useState<SettingsState | null>(null);
	useEffect(() => { api<SettingsState>("/admin/settings").then(setSettings).catch(() => setSettings(null)); }, []);
	if (!settings) return <p style={{ fontSize: 13 }}>Loading…</p>;
	return <div style={{ display: "grid", gap: 8, fontSize: 14 }}><div>Agents: <strong>{settings.agents.mode}</strong></div><div>Humans: <strong>{settings.humans.mode}</strong></div><div>Plans: <strong>{settings.humans.plans.length}</strong></div></div>;
}

export const pages = { "/settings": SettingsPage, "/rules": RulesPage };
export const widgets = { overview: OverviewWidget };

const gridStyle: React.CSSProperties = { display: "grid", gap: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))", marginBottom: 12 };
const buttonStyle: React.CSSProperties = { padding: "10px 16px", background: "#111827", color: "#fff", borderRadius: 999, border: "none", cursor: "pointer", fontWeight: 600 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff" };
const helpText: React.CSSProperties = { margin: 0, fontSize: 13, color: "#6b7280" };
const captionText: React.CSSProperties = { margin: "6px 0 0", fontSize: 12, color: "#6b7280" };
const warningStyle: React.CSSProperties = { padding: 12, borderRadius: 8, background: "#fef3c7", color: "#92400e" };
