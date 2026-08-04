# XLS-68 × x402: facilitator-sponsored fees on XRPL — working prototype

Reference implementation for the proposed x402 `xrplFeeSponsoring` extension:
facilitator-sponsored network fees for the XRPL `exact` scheme via the XLS-68
`Sponsor` amendment (live on XRPL Devnet, verified against the `Amendments`
ledger object).

The merged XRPL exact scheme states it "does not support facilitator-sponsored
network fees… Supporting fee sponsorship would require a different payment
model." XLS-68 is that payment model. This repo proves it end to end.

## Run

```bash
npm install
npm run prototype   # full 7-act run against XRPL Devnet (faucet-funded)
npm test            # offline tests (signing/binding, no network)
```

## What the prototype proves

| act | result |
| --- | --- |
| Zero-XRP payer onboarded (`tfSponsorCreatedAccount`, 1 drop) | `AccountRoot.Sponsor` = facilitator |
| TrustSet with fee + reserve sponsored (co-signed) | payer balance unchanged (1 drop) |
| IOU payment, fee sponsored | payer XRP untouched; facilitator paid exactly the fee |
| Tamper with `Fee` after sponsor signed | LOCAL_REJECT `"Sponsor: Invalid signature."` |
| Sponsor alters `Amount` after payer signed | LOCAL_REJECT `"Invalid signature."` |
| Replay sponsor signature on a new tx | LOCAL_REJECT `"Sponsor: Invalid signature."` |
| Sponsored tx without signature or `Sponsorship` object | `terNO_PERMISSION` |
| Pre-funded mode (`Sponsorship` object, no co-sign) | `tesSUCCESS`; pool decremented |
| `Fee` above `Sponsorship.MaxFee` | `terINSUF_FEE_B` (fee-drain ceiling) |

A validated run with transaction hashes: `evidence/devnet-run-2026-08-04.json`.

## Key mechanics

- Sponsor and payer sign the **identical** `STX\0`-prefixed signing payload
  (rippled `STTx::checkSingleSign`). `SponsorSignature`
  (`{SigningPubKey, TxnSignature}`) and `TxnSignature` are non-signing fields.
  Neither party can alter any term after the other signs; `Account` +
  `Sequence` in the signed data prevent replay.
- Standard client libraries cannot encode the sponsor fields yet: encoding
  here uses `XrplDefinitions` built from the target network's own
  `server_definitions`.
- `ter` results are retriable: a payer-signed sponsored tx rejected for a
  missing `Sponsorship` object applies automatically once the sponsorship is
  funded (observed live — see the evidence run's pool arithmetic).

## Implementation-vs-draft divergence (Devnet, rippled 3.3.0-rc5)

Observed differences from the XLS-0068 draft text, found by probing the
transaction template:

- `SponsorshipSet` is transaction type **91** (reference PR text says 86).
- Pre-funding uses **`FeeAmountDelta` (additive)**; top-level
  `FeeAmount`/`RemainingOwnerCount` are rejected with
  `Field '…' found in disallowed location.`
- Creating a budget-less `Sponsorship` fails with `tecNO_PERMISSION`.

Implementers should code against the target network's `server_definitions`,
not the draft field tables.

## Provenance

Built with significant AI assistance (Claude) under significant human
monitoring, direction, and correction. Every field name and behavior claim
verified against live XRPL Devnet and rippled source.

MIT licensed.
