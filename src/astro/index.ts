// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AstroIntegration } from "astro";
import { x402 } from "@emdash-cms/x402";
import { resolveOptions, type PaidAccessOptions } from "./options.js";
export type { PaidAccessLocals } from "./runtime.js";
export type { PaidAccessOptions } from "./options.js";

export function paidAccessAstro(input: PaidAccessOptions = {}): AstroIntegration {
	return { name: "emdash-paid-access", hooks: {
		"astro:config:setup": ({ updateConfig, addMiddleware, injectRoute }) => {
			const options = resolveOptions(input);
			updateConfig({
				// These are placeholders: every enforcement call supplies payTo/network from plugin settings.
				integrations: [x402({ payTo: "0x0000000000000000000000000000000000000000", network: "eip155:84532", facilitatorUrl: options.facilitatorUrl })],
				vite: {
					plugins: [{ name: "paid-access-config", resolveId: id => id === "virtual:paid-access/config" ? "\0virtual:paid-access/config" : undefined,
						load: id => id === "\0virtual:paid-access/config" ? `export default ${JSON.stringify(options)}` : undefined }],
					ssr: { noExternal: ["emdash-paid-access"], optimizeDeps: { exclude: ["emdash-paid-access"] } },
					optimizeDeps: { exclude: ["emdash-paid-access"] },
				},
			});
			addMiddleware({ entrypoint: "emdash-paid-access/astro/middleware", order: "post" });
			injectRoute({ pattern: `${options.agentRoutePrefix}/[collection]/[slug].md`, entrypoint: "emdash-paid-access/astro/routes/agent-entry", prerender: false });
			injectRoute({ pattern: `${options.agentRoutePrefix}/offers`, entrypoint: "emdash-paid-access/astro/routes/offers", prerender: false });
			if (options.injectAccountRoutes) {
				// Astro default trailingSlash: "ignore" matches both /verify and the core callback /verify/.
				for (const action of ["sign-in", "verify", "logout", "checkout", "complete", "portal"]) {
					injectRoute({ pattern: `${options.accountPath}/${action}`, entrypoint: "emdash-paid-access/astro/routes/account", prerender: false });
				}
			}
		},
	} };
}
export default paidAccessAstro;
