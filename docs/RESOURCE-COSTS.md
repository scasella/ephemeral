# Resources and compute estimates

The launch review shows a **reference configuration**, and the selected running machine shows its observed resources and estimated compute cost. These are planning aids. Ephemeral does not read your E2B invoice, credit balance, subscription or negotiated prices.

## Before launch

The reference example uses **2 vCPUs and 4 GiB of RAM** for the initial one-hour session. This is not a verified allocation or quote for your configured custom template. The actual allocation is checked after launch. Your configured E2B template determines the machine size.

At E2B's published rates checked **October 16, 2026**, that example is **$0.1656/hour** (about **$0.166/hour**). A further 30 minutes at that allocation is **$0.0828**. The app still starts sessions with one hour and permits extensions only where its existing configuration allows them. [E2B pricing](https://e2b.dev/pricing).

## While a machine runs

Resource inspection reads the current sandbox's allocation and recent metrics without starting a process, resuming compute or extending its lifetime. Use the resource refresh control to request a new observation. Switching workspace detail tabs keeps the terminal attached.

Allocated CPU and RAM determine the compute estimate; CPU utilization is a separate observation. An idle running machine can still consume compute. Memory is shown using binary units: **1 GiB = 1,024 MiB**. The provider's usable memory and disk totals can differ from its allocation, so measured totals are not used as the billable RAM size.

E2B documents timestamped CPU, memory and disk samples collected every five seconds; a newly started machine may have no sample yet. Missing, invalid or stale metrics are not reported as zero. [E2B sandbox metrics](https://docs.e2b.dev/sandbox/metrics).

The estimate uses allocated vCPUs and GiB of RAM multiplied by the published per-second rates. The elapsed estimate stops at the observation time. The projection to the scheduled deadline uses the earliest applicable app or provider deadline. It is not a guaranteed maximum charge: failed cleanup, an uncertain creation outcome or provider-side billing behavior can require separate investigation.

Rates are dated and linked to their source. If their check date becomes old, the interface flags that the rates need review. Ephemeral does not automatically fetch pricing or change your account's billing settings.

## What the numbers exclude

- Subscription fees, taxes, discounts, negotiated rates and credit deductions.
- Template builds, other sandboxes and any storage, network or other provider charges.
- ChatGPT/Codex plan costs and model usage.

Consult your [E2B console](https://console.e2b.dev) for account usage and billing. A one-hour session deadline controls the app's lifecycle; the displayed estimate is not a spending limit.

## Unknown, ended and simulated sessions

A failed observation clears current resource and cost claims. A previously displayed sample, if shown, is labeled with its observation time. Ending or expiring a machine makes current inspection unavailable. This feature does not retain a durable usage ledger or a final session invoice.

In local simulation, resource values are synthetic and any dollar example is illustrative. No E2B compute is created or charged by that simulation. Real account balances and billing are not verified by the local demo.
