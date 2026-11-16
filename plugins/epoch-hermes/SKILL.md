---
name: epoch-hermes
description: Estimate Hermes Kanban work and show its Monte Carlo chart in the Epoch Desktop page.
---

# Epoch in Hermes

Use `epoch_estimate` with a title and optional three-point hours; successful estimates and recorded actuals refresh the Desktop page through local events.

Check that Epoch is on in Desktop Capabilities -> Plugins; enabling the pane is the one step a person does, then the agent can open it with `epoch_show`.

Call `epoch_show` with `view: "bars"` (Distribution), `"cdf"` (Chance done by), or `"dots"` (50 dots), plus an optional `item_id` containing a Kanban card id (1–80 letters, digits, underscores, dots, colons or hyphens).
The page charts open cards with an `epoch: o/m/p` hint; `item_id` focuses that card, and ambiguous or missing ids are reported on the page.
`/epoch status` repeats the pane setup guidance; it does not confirm a connected Desktop listener.
The page must be open and enabled to react, and a broadcast is a request, not proof that someone saw it.
