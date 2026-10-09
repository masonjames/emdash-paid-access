# Coexistence and migration

[Documentation](../README.md) / Migration

Existing Restrict With Stripe sites can evaluate Paid Access while leaving the
old plugin responsible for members. This beta provides delegation, **not an
automatic data migration or session bridge**.

## Evaluate without replacing member access

1. Back up the current site and database, then rehearse with copied/sanitized data
   on a test host. Record the existing rule and member behavior before changing it.
2. Keep Restrict With Stripe installed. Install the Paid Access companion and
   core, then select **Use Restrict With Stripe (during migration)** in Members.
3. Preserve your existing sign-in, pricing, and account UI. If the site already
   owns `/account/*`, set `injectAccountRoutes: false` so injected handlers do not
   collide with those pages.
4. Use `PaidContent` for the body and keep your existing locked UI in its named
   slot, or integrate the access decision explicitly in the existing theme.
5. Verify known eligible and ineligible readers against both plugins' rules.
   Do not assume two different plan IDs mean the same Stripe product.

Example theme slot, using your site's own existing component:

```astro
---
import PaidContent from "emdash-paid-access/components/PaidContent.astro";
import ExistingMembershipGate from "../components/ExistingMembershipGate.astro";
// `post` is loaded by the page; ExistingMembershipGate is your own component.
---
<PaidContent entry={post} collection="posts">
  <ExistingMembershipGate slot="locked" />
</PaidContent>
```

`ExistingMembershipGate` is illustrative, not a component shipped by this package.

## What delegation does

- The companion probes the legacy public session route and reports presence to
  the core through a private route.
- The decision honors restrictions from both plugins. Access is denied if the
  legacy response cannot be verified or cannot satisfy Paid Access requirements.
- The settings handler refuses Stripe mode when it knows the legacy plugin is
  active. The runtime also downgrades a conflicting Stripe configuration to
  delegation.
- Paid Access's own pricing/checkout is not the member entry point in delegation.
- Agents do not obtain free Markdown while the legacy plugin is active or
  delegation is configured. Explicit paid rules are still required for sales.

Presence is cached for the process lifetime; absence is rechecked after up to
60 seconds. Restart the host after enabling or removing the legacy plugin to
avoid a transition that depends on that cache. A probe error fails closed.

## Plan the eventual cutover

Before removing the legacy plugin, inventory and map:

| Item | Required decision |
| --- | --- |
| Plans and products | Which Paid Access plan IDs grant each existing entitlement? |
| Entry/taxonomy restrictions | Which rules must be copied, and how are conflicts resolved? |
| Customer records | How will existing Stripe customer/product relationships be reconciled? |
| Sessions | How will members sign in again? This beta does not bridge legacy cookies. |
| Free members | What happens to readers who have no paid product entitlement? |
| Checkout offers | Are displayed prices/trials actually supported by the new checkout? |
| Rollback | Which build, data backup, and account UI restore the prior behavior? |

Free-member entitlements and automatic migration are outside the beta. Do not
replace a working free-members rule with a Paid Access members rule and assume
sign-in alone will unlock it. A trial label does not configure Checkout trials.

Rehearse the full cutover and rollback before scheduling it. Compare signed-out,
eligible, ineligible, canceled, and legacy-session cases, then run the
[public-content/cache audit](hosting-and-caching.md).

[Stripe behavior](stripe-memberships.md) · [Policy reference](../reference/access-policies.md)
