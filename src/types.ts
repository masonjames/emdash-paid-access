// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { HumanPlan } from "./plans.js";

export type StripeEnvironment = "live" | "test";
export type AgentMode = "off" | "tokens-only" | "paid";
export type AgentRail = "origin-x402" | "gateway";
export type HumanMode = "off" | "stripe" | "delegate";
export type AccessPolicy = "public" | "agents-pay" | "members" | "members-only";

export interface AgentSettings {
	mode: AgentMode;
	rail: AgentRail;
	payTo: string;
	network: "" | "eip155:84532" | "eip155:8453";
	edgeTrust: "none" | string;
}

export interface HumanSettings {
	mode: HumanMode;
	plans: HumanPlan[];
}

export interface PaidAccessSettings {
	agents: AgentSettings;
	humans: HumanSettings;
	stripeSecretKey: string | null;
	stripeSecretKeyMasked: string;
	stripePublishableKey: string;
	stripeAccountId: string;
	stripeEnvironment: StripeEnvironment;
	showExcerpts: boolean;
	emailConfigured: boolean;
	isConfigured: boolean;
}

export interface AuthTokenRecord {
	email: string;
	redirect: string;
	intent: "signin" | "subscribe-free";
	expiresAt: string;
	used: boolean;
	createdAt: string;
}

export interface SessionRecord {
	email: string;
	expiresAt: string;
	createdAt: string;
}

export interface CustomerRecord {
	email: string;
	stripeCustomerId: string;
	createdAt: string;
	updatedAt: string;
}

export interface ContentRestrictionRecord {
	contentId: string;
	collectionSlug: string;
	slug?: string | null;
	title?: string | null;
	requiredPlanSlugs?: string[];
	productIds?: string[];
	policy: AccessPolicy;
	agentPrice?: string | null;
	passEligible?: boolean;
	source?: "manual";
	createdAt: string;
	updatedAt?: string;
}

export interface TaxonomyRestrictionRecord {
	taxonomyName: string;
	termId: string;
	requiredPlanSlugs?: string[];
	productIds?: string[];
	policy: AccessPolicy;
	agentPrice?: string | null;
	passEligible?: boolean;
	createdAt: string;
	updatedAt?: string;
}

export interface ReceiptRecord {
	entryId: string;
	collectionSlug: string;
	slug: string;
	rail: "origin-x402" | "gateway";
	payer: string;
	amount: string;
	network: string;
	transaction: string;
	createdAt: string;
}

export interface MemberSessionState {
	authenticated: boolean;
	email: string | null;
}

export interface AccessDecision {
	delegated?: boolean;
	restricted: boolean;
	authenticated: boolean;
	hasAccess: boolean;
	email: string | null;
	requiredPlanSlugs: string[];
	requiredProductIds: string[];
	error?: string;
}
