# DisputeDesk demo script (2:30)

**Setup before recording**

```bash
npm run reset      # with the dev server stopped: clean case history (seeded past cases come back)
npm run dev
```

- Use mock PayPal data so every case is ready. Set `ANTHROPIC_API_KEY` so the badge reads the Claude model, not "Offline rules".
- Browser at 1440×900, zoom 100%. Open http://localhost:3000 once beforehand so routes are compiled.
- Keep a second tab on `/disputes/PP-D-1005` ready.

---

### 0:00 – 0:20 · The problem (dashboard)

> "Small PayPal merchants lose disputes they could have won, and refund ones they should have fought, because each one means digging through tracking pages and order emails. DisputeDesk gives that job to an AI agent and keeps the merchant in control."

- Show the queue: **10 open disputes, about $1,100 at risk, 2 due within 5 days**.
- Point at the status chips and the mode badges (PayPal mock or sandbox, Claude model).

### 0:20 – 1:10 · An easy win (PP-D-1001, item not received)

- Open **Jordan Ellis, $129, "I never got my headphones."**
- Scroll the left column briefly: order, then the timeline ending in *Delivered, signed by J. ELLIS*.
- Click **Analyze with AI**. While the trace streams:

> "The agent is calling PayPal: the dispute, the capture and order, tracking. Then it searches this merchant's past cases for precedent."

- Expand one step (e.g. *Checked shipment tracking*) to show the raw tool input and output.
- On the recommendation card: **Contest with evidence, 90%**, the evidence list, and the reasoning that cites *HIST-0801 … ended as "won"*.

> "It doesn't just say 'contest'. It tells you why, how confident it is, and it learned from how a similar case went."

### 1:10 – 1:45 · Human approval (same dispute)

- Edit one sentence in the **Statement to PayPal** to show it's editable ("Edited by you" appears).
- Click **Approve**. Pause on the confirmation:

> "Nothing moves until I confirm, and it tells me exactly what will happen."

- Click **Yes, execute**. Show the outcome: `provideEvidence` with the UPS tracking number, `sendMessageToBuyer`.

> "Behind this is PayPal's provide-evidence endpoint. The agent itself can't call it: its tools are read-only, and the approve route has an idempotency guard so a double-click can't run it twice."

### 1:45 – 2:10 · The agent says *don't* fight (PP-D-1002 or PP-D-1008)

- Go back and open **Daniel Osei, PP-D-1008, "charged twice"**. Analyze.
- Result: **Issue refund, 94%**: two identical captures 90 seconds apart, one shipment.

> "Here it recommends refunding. A real double charge is unwinnable, and fighting it only adds a fee. On approval, DisputeDesk calls PayPal's refund API with a deterministic request ID, then submits proof of refund."

- Optional (if time): **PP-D-1005**, the repeat disputer claiming fake sneakers. The agent contests at a lower confidence and flags the buyer's 4 prior disputes.

### 2:10 – 2:30 · Memory and wrap-up (case history)

- Open **Case history** and search **"signature"**. Results include past wins and the case just approved.

> "Every dispute, recommendation, decision and outcome is stored. That's the memory the agent searches. PayPal provides the data and the actions, Claude does the investigation and writing, and the merchant makes the call. That's DisputeDesk."

---

**Backup lines if something goes wrong**

- Analysis error banner → "Retry" re-runs it. Without an API key the offline engine produces the same flow.
- Already-approved dispute → stop the server, `npm run reset`, start it again.
