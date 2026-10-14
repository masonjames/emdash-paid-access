// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Public discovery for a concrete Markdown URL. Never include the paid body in examples. */
export const markdownDiscoveryExtensions = {
	bazaar: {
		info: {
			input: { type: "http", method: "GET", queryParams: {} },
			output: {
				type: "text",
				format: "text/markdown",
				example: "# Example article\n\nSynthetic example content.",
			},
		},
		schema: {
			type: "object",
			properties: {
				input: {
					type: "object",
					properties: {
						type: { const: "http" },
						method: { const: "GET" },
						queryParams: { type: "object", properties: {}, additionalProperties: false },
					},
					required: ["type", "method", "queryParams"],
				},
				output: {
					type: "object",
					properties: {
						type: { const: "text" },
						format: { const: "text/markdown" },
						example: { type: "string" },
					},
					required: ["type", "format", "example"],
				},
			},
			required: ["input", "output"],
		},
	},
};
