// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { HumanPlan } from "../../src/plans.js";

export const MASONJAMES_PLANS: HumanPlan[] = [
	{
		slug: "free",
		name: "Free",
		description: "Email subscription and free member areas.",
		stripeProductId: null,
		grantsVisibility: ["public"],
	},
	{
		slug: "default-product",
		name: "Content & Chatbot Access",
		description: "Paid member writing and chatbot access.",
		stripeProductId: null,
		grantsVisibility: ["members"],
		monthlyLabel: "USD 5/mo",
		yearlyLabel: "USD 50/yr",
	},
	{
		slug: "content-personall-ai",
		name: "All Access Pass",
		description: "Content and premium AI experiences.",
		stripeProductId: null,
		grantsVisibility: ["members", "paid"],
		monthlyLabel: "USD 15/mo",
		yearlyLabel: "USD 150/yr",
		trialLabel: "14-day trial",
	},
];
