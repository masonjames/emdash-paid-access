// Copyright 2026 Stranger Studios.
// Modified by Mason James, 2026-09-23.
// SPDX-License-Identifier: GPL-2.0-or-later

import { isRecord, normalizeStringArray } from "./utils.js";

export type BillingInterval = "monthly" | "yearly";

export interface HumanPlan {
	slug: string;
	name: string;
	description?: string;
	stripeProductId: string | null;
	grantsVisibility: string[];
	monthlyLabel?: string;
	yearlyLabel?: string;
	trialLabel?: string;
}

export function normalizeHumanPlans(value: unknown): HumanPlan[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	const plans: HumanPlan[] = [];
	const slugs = new Set<string>();
	for (const candidate of value) {
		if (!isRecord(candidate)) {
			return null;
		}
		const slug = typeof candidate.slug === "string" ? candidate.slug.trim() : "";
		const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
		if (!slug || !name || slugs.has(slug)) {
			return null;
		}
		if (candidate.stripeProductId != null && typeof candidate.stripeProductId !== "string") {
			return null;
		}
		if (!Array.isArray(candidate.grantsVisibility)) {
			return null;
		}

		slugs.add(slug);
		plans.push({
			slug,
			name,
			description: typeof candidate.description === "string" ? candidate.description.trim() : undefined,
			stripeProductId:
				typeof candidate.stripeProductId === "string" && candidate.stripeProductId.trim()
					? candidate.stripeProductId.trim()
					: null,
			grantsVisibility: normalizeStringArray(candidate.grantsVisibility),
			monthlyLabel: typeof candidate.monthlyLabel === "string" ? candidate.monthlyLabel.trim() : undefined,
			yearlyLabel: typeof candidate.yearlyLabel === "string" ? candidate.yearlyLabel.trim() : undefined,
			trialLabel: typeof candidate.trialLabel === "string" ? candidate.trialLabel.trim() : undefined,
		});
	}

	return plans;
}

/** The audience segment grammar shared with visual builders. */
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/** `plan:<slug>`, or null when the slug can't form a valid segment. Not part of normalizeHumanPlans, so stored catalogs keep loading. */
export function planSegment(slug: string): string | null {
	return slug && SEGMENT_PATTERN.test(`plan:${slug}`) ? `plan:${slug}` : null;
}

export function isPlanSlug(value: unknown, plans: HumanPlan[]): value is string {
	return typeof value === "string" && plans.some((plan) => plan.slug === value);
}

export function getPlan(plans: HumanPlan[], slug: string): HumanPlan | undefined {
	return plans.find((plan) => plan.slug === slug);
}

export function isBillingInterval(value: unknown): value is BillingInterval {
	return value === "monthly" || value === "yearly";
}

export function getRequiredPlanSlugsForVisibility(plans: HumanPlan[], visibility: string | null | undefined): string[] {
	if (!visibility) {
		return [];
	}
	return plans.filter((plan) => plan.grantsVisibility.includes(visibility)).map((plan) => plan.slug);
}
