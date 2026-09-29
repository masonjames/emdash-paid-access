// Copyright 2026 Mason James.
// SPDX-License-Identifier: GPL-2.0-or-later

declare module "virtual:paid-access/config" {
	const options: Required<import("./options.js").PaidAccessOptions>;
	export default options;
}
