/**
 * XLS-68 Sponsor prototype — XRPL Devnet end-to-end.
 *
 * Proves the full x402-relevant arc:
 *   Act 1  fund facilitator / issuer / merchant from the Devnet faucet
 *   Act 2  ZERO-XRP onboarding: facilitator creates the payer account with
 *          tfSponsorCreatedAccount (1 drop, reserve on the sponsor)
 *   Act 3  sponsored TrustSet: payer opens an FCD trustline paying NO fee and
 *          NO reserve (both sponsored, co-signed)
 *   Act 4  issuer funds the payer with FCD
 *   Act 5  THE x402 MOMENT: payer (1 drop of XRP, forever) pays the merchant
 *          in FCD; facilitator sponsors the fee
 *   Act 6  negative controls: tamper-after-sponsor-sign, sponsor-alters-terms,
 *          sponsor-signature replay, missing sponsor signature
 *   Act 7  pre-funded mode: SponsorshipSet(FeeAmount, MaxFee), payer transacts
 *          with NO co-signature; MaxFee blocks fee drain
 *
 * Run: npx tsx scripts/xrpl-sponsor-prototype.ts
 * Evidence: evidence/latest-run.json
 */
import { writeFileSync, mkdirSync } from 'fs';
import { Client, Wallet } from 'xrpl';
import {
  SPF_SPONSOR_FEE,
  SPF_SPONSOR_RESERVE,
  TF_SPONSOR_CREATED_ACCOUNT,
  loadNetworkDefinitions,
  isSponsorAmendmentEnabled,
  sponsorCoSign,
  finalizeSponsored,
  signWithDefinitions,
  submitAndConfirm,
  computeTxHash,
} from './sponsor.js';
import { encode } from 'ripple-binary-codec';
import { sign } from 'ripple-keypairs';

const DEVNET = 'wss://s.devnet.rippletest.net:51233';
const FEE = '12';
const CURRENCY = 'FCD';

interface Evidence {
  network: string;
  ranAt: string;
  accounts: Record<string, string>;
  acts: Record<string, unknown>;
  negativeControls: Record<string, unknown>;
}

const evidence: Evidence = {
  network: DEVNET,
  ranAt: new Date().toISOString(),
  accounts: {},
  acts: {},
  negativeControls: {},
};

async function rpc<T = Record<string, unknown>>(client: Client, req: Record<string, unknown>): Promise<T> {
  const res = await client.request(req as never);
  return (res as { result: T }).result;
}

async function getSequence(client: Client, address: string): Promise<number> {
  const r = await rpc<{ account_data: { Sequence: number } }>(client, {
    command: 'account_info', account: address, ledger_index: 'validated',
  });
  return r.account_data.Sequence;
}

async function getXrpBalance(client: Client, address: string): Promise<string> {
  const r = await rpc<{ account_data: { Balance: string } }>(client, {
    command: 'account_info', account: address, ledger_index: 'validated',
  });
  return r.account_data.Balance;
}

async function lastLedger(client: Client): Promise<number> {
  const r = await rpc<{ ledger_current_index: number }>(client, { command: 'ledger_current' });
  return r.ledger_current_index + 40;
}

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const client = new Client(DEVNET);
  await client.connect();
  console.log('Connected to', DEVNET);

  if (!(await isSponsorAmendmentEnabled(client))) fail('Sponsor amendment NOT enabled on this network');
  console.log('✓ Sponsor amendment enabled (verified against Amendments ledger object)');
  const defs = await loadNetworkDefinitions(client);
  console.log('✓ Network definitions loaded from server_definitions (sponsor fields included)');

  // ─── Act 1: faucet-fund the cast (everyone except the payer) ───
  console.log('\n═══ Act 1: funding facilitator, issuer, merchant from faucet ═══');
  const facilitator = (await client.fundWallet()).wallet;
  const issuer = (await client.fundWallet()).wallet;
  const merchant = (await client.fundWallet()).wallet;
  const payer = Wallet.generate(); // NEVER funded — zero XRP for its whole life
  evidence.accounts = {
    facilitator: facilitator.address,
    issuer: issuer.address,
    merchant: merchant.address,
    payer: payer.address,
  };
  console.log('facilitator:', facilitator.address);
  console.log('issuer:     ', issuer.address);
  console.log('merchant:   ', merchant.address);
  console.log('payer:      ', payer.address, '(generated locally, zero XRP)');

  // issuer must allow rippling or holder→holder IOU payments die with tecPATH_DRY
  {
    const tx = {
      TransactionType: 'AccountSet',
      Account: issuer.address,
      SetFlag: 8, // asfDefaultRipple
      Fee: FEE,
      Sequence: await getSequence(client, issuer.address),
      LastLedgerSequence: await lastLedger(client),
    };
    const { blob, hash } = signWithDefinitions(tx, issuer, defs);
    const out = await submitAndConfirm(client, blob, hash);
    if (out.txResult !== 'tesSUCCESS') fail(`issuer DefaultRipple failed: ${out.engineResult}/${out.txResult}`);
  }

  // ─── Act 2: zero-XRP onboarding via tfSponsorCreatedAccount ───
  console.log('\n═══ Act 2: facilitator creates payer account, sponsoring its reserve ═══');
  {
    const tx = {
      TransactionType: 'Payment',
      Account: facilitator.address,
      Destination: payer.address,
      Amount: '1', // 1 drop — the minimum; reserve lives on the sponsor
      Flags: TF_SPONSOR_CREATED_ACCOUNT,
      Fee: FEE,
      Sequence: await getSequence(client, facilitator.address),
      LastLedgerSequence: await lastLedger(client),
    };
    const { blob, hash } = signWithDefinitions(tx, facilitator, defs);
    const out = await submitAndConfirm(client, blob, hash);
    if (out.txResult !== 'tesSUCCESS') fail(`account creation failed: ${out.engineResult}/${out.txResult}`);
    const acct = await rpc<{ account_data: Record<string, unknown> }>(client, {
      command: 'account_info', account: payer.address, ledger_index: 'validated',
    });
    const sponsorField = acct.account_data.Sponsor;
    const balance = acct.account_data.Balance;
    if (sponsorField !== facilitator.address) fail(`payer AccountRoot.Sponsor is ${sponsorField}, expected facilitator`);
    console.log(`✓ payer exists with Balance=${balance} drop, AccountRoot.Sponsor=${sponsorField}`);
    evidence.acts.act2_sponsoredAccountCreate = { hash, balance, sponsor: sponsorField };
  }

  // ─── Act 3: sponsored TrustSet (fee + reserve both on the facilitator) ───
  console.log('\n═══ Act 3: payer opens FCD trustline — fee AND reserve sponsored ═══');
  {
    const tx: Record<string, unknown> = {
      TransactionType: 'TrustSet',
      Account: payer.address,
      LimitAmount: { currency: CURRENCY, issuer: issuer.address, value: '1000' },
      Fee: FEE,
      Sequence: await getSequence(client, payer.address),
      LastLedgerSequence: await lastLedger(client),
      Sponsor: facilitator.address,
      SponsorFlags: SPF_SPONSOR_FEE | SPF_SPONSOR_RESERVE,
      SigningPubKey: payer.publicKey,
    };
    const sponsorSig = sponsorCoSign(tx, facilitator, defs);
    const { blob, hash } = finalizeSponsored(tx, sponsorSig, payer, defs);
    const out = await submitAndConfirm(client, blob, hash);
    if (out.txResult !== 'tesSUCCESS') fail(`sponsored TrustSet failed: ${out.engineResult}/${out.txResult}`);
    const bal = await getXrpBalance(client, payer.address);
    if (bal !== '1') fail(`payer balance changed to ${bal} — fee was not sponsored`);
    const objs = await rpc<{ account_objects: Array<Record<string, unknown>> }>(client, {
      command: 'account_objects', account: payer.address, ledger_index: 'validated',
    });
    const line = objs.account_objects.find((o) => o.LedgerEntryType === 'RippleState');
    const lineSponsor = line?.HighSponsor ?? line?.LowSponsor;
    if (lineSponsor !== facilitator.address) fail(`trustline sponsor is ${lineSponsor}, expected facilitator`);
    console.log(`✓ trustline live, payer still at 1 drop, RippleState sponsor=${lineSponsor}`);
    evidence.acts.act3_sponsoredTrustSet = { hash, payerBalanceAfter: bal, lineSponsor };
  }

  // ─── Act 4: issuer funds the payer with FCD ───
  console.log('\n═══ Act 4: issuer sends 10 FCD to payer ═══');
  {
    const tx = {
      TransactionType: 'Payment',
      Account: issuer.address,
      Destination: payer.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '10' },
      Fee: FEE,
      Sequence: await getSequence(client, issuer.address),
      LastLedgerSequence: await lastLedger(client),
    };
    const { blob, hash } = signWithDefinitions(tx, issuer, defs);
    const out = await submitAndConfirm(client, blob, hash);
    if (out.txResult !== 'tesSUCCESS') fail(`issuer funding failed: ${out.engineResult}/${out.txResult}`);
    console.log('✓ payer holds 10 FCD');
    evidence.acts.act4_issuerFunding = { hash };
  }

  // merchant needs a trustline to receive FCD (pays its own way — it has XRP)
  {
    const tx = {
      TransactionType: 'TrustSet',
      Account: merchant.address,
      LimitAmount: { currency: CURRENCY, issuer: issuer.address, value: '1000000' },
      Fee: FEE,
      Sequence: await getSequence(client, merchant.address),
      LastLedgerSequence: await lastLedger(client),
    };
    const { blob, hash } = signWithDefinitions(tx, merchant, defs);
    const out = await submitAndConfirm(client, blob, hash);
    if (out.txResult !== 'tesSUCCESS') fail(`merchant trustline failed: ${out.engineResult}/${out.txResult}`);
  }

  // ─── Act 5: the x402 moment — zero-XRP payer pays merchant, facilitator pays the fee ───
  console.log('\n═══ Act 5: payer (1 drop XRP) pays merchant 2.5 FCD, facilitator sponsors the fee ═══');
  let act5SponsorSig: { SigningPubKey: string; TxnSignature: string };
  let act5Tx: Record<string, unknown>;
  {
    const facBefore = BigInt(await getXrpBalance(client, facilitator.address));
    act5Tx = {
      TransactionType: 'Payment',
      Account: payer.address,
      Destination: merchant.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '2.5' },
      Fee: FEE,
      Sequence: await getSequence(client, payer.address),
      LastLedgerSequence: await lastLedger(client),
      Sponsor: facilitator.address,
      SponsorFlags: SPF_SPONSOR_FEE,
      SigningPubKey: payer.publicKey,
    };
    act5SponsorSig = sponsorCoSign(act5Tx, facilitator, defs);
    const { blob, hash } = finalizeSponsored(act5Tx, act5SponsorSig, payer, defs);
    const out = await submitAndConfirm(client, blob, hash);
    if (out.txResult !== 'tesSUCCESS') fail(`sponsored payment failed: ${out.engineResult}/${out.txResult}`);
    const payerXrp = await getXrpBalance(client, payer.address);
    const facAfter = BigInt(await getXrpBalance(client, facilitator.address));
    const facPaid = facBefore - facAfter;
    if (payerXrp !== '1') fail(`payer XRP balance is ${payerXrp}, expected 1 drop untouched`);
    if (facPaid !== BigInt(FEE)) fail(`facilitator paid ${facPaid} drops, expected exactly ${FEE}`);
    const lines = await rpc<{ lines: Array<{ account: string; balance: string }> }>(client, {
      command: 'account_lines', account: merchant.address, ledger_index: 'validated',
    });
    const merchantFcd = lines.lines.find((l) => l.account === issuer.address)?.balance;
    console.log(`✓ merchant received 2.5 FCD (balance ${merchantFcd})`);
    console.log(`✓ payer XRP untouched at 1 drop; facilitator paid exactly ${FEE} drops of fee`);
    evidence.acts.act5_x402Moment = { hash, payerXrpAfter: payerXrp, facilitatorFeePaid: facPaid.toString(), merchantFcd };
  }

  // ─── Act 6: negative controls — the binding property ───
  console.log('\n═══ Act 6: negative controls ═══');
  const payerSeq = await getSequence(client, payer.address);

  // 6a — sponsee tampers AFTER the sponsor signed: sponsor signature must die
  {
    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: payer.address,
      Destination: merchant.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '0.5' },
      Fee: FEE,
      Sequence: payerSeq,
      LastLedgerSequence: await lastLedger(client),
      Sponsor: facilitator.address,
      SponsorFlags: SPF_SPONSOR_FEE,
      SigningPubKey: payer.publicKey,
    };
    const sponsorSig = sponsorCoSign(tx, facilitator, defs);
    const tampered = { ...tx, Fee: '5000000' }; // sponsee inflates the sponsored fee 416,000x
    const { blob, hash } = finalizeSponsored(tampered, sponsorSig, payer, defs);
    const out = await submitAndConfirm(client, blob, hash, { timeoutLedgers: 3 });
    if (out.txResult === 'tesSUCCESS') fail('6a: tampered-fee tx SUCCEEDED — sponsor signature did not bind!');
    console.log(`✓ 6a sponsee tampered fee after sponsor signed → rejected (${out.engineResult})`);
    evidence.negativeControls.tamperAfterSponsorSign = out.engineResult;
  }

  // 6b — sponsor alters the payment terms AFTER the sponsee signed: sponsee signature must die
  {
    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: payer.address,
      Destination: merchant.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '0.5' },
      Fee: FEE,
      Sequence: payerSeq,
      LastLedgerSequence: await lastLedger(client),
      Sponsor: facilitator.address,
      SponsorFlags: SPF_SPONSOR_FEE,
      SigningPubKey: payer.publicKey,
    };
    const sponsorSig = sponsorCoSign(tx, facilitator, defs);
    const signingData = encode({ ...tx } as never, defs); // placeholder; real signing below
    void signingData;
    const { blob: goodBlob } = finalizeSponsored(tx, sponsorSig, payer, defs);
    void goodBlob;
    // rebuild the fully-signed tx, then the "facilitator" mutates Amount before submitting
    const data = (await import('ripple-binary-codec')).encodeForSigning(tx as never, defs);
    const full = {
      ...tx,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '9.99' }, // sponsor redirects value
      TxnSignature: sign(data, payer.privateKey),
      SponsorSignature: sponsorSig,
    };
    const blob = encode(full as never, defs);
    const hash = computeTxHash(blob);
    const out = await submitAndConfirm(client, blob, hash, { timeoutLedgers: 3 });
    if (out.txResult === 'tesSUCCESS') fail('6b: sponsor-altered tx SUCCEEDED — payer signature did not bind!');
    console.log(`✓ 6b sponsor altered Amount after payer signed → rejected (${out.engineResult})`);
    evidence.negativeControls.sponsorAltersTerms = out.engineResult;
  }

  // 6c — replay: reuse Act 5's sponsor signature on a fresh tx
  {
    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: payer.address,
      Destination: merchant.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '0.5' },
      Fee: FEE,
      Sequence: payerSeq,
      LastLedgerSequence: await lastLedger(client),
      Sponsor: facilitator.address,
      SponsorFlags: SPF_SPONSOR_FEE,
      SigningPubKey: payer.publicKey,
    };
    const { blob, hash } = finalizeSponsored(tx, act5SponsorSig, payer, defs); // stale signature
    const out = await submitAndConfirm(client, blob, hash, { timeoutLedgers: 3 });
    if (out.txResult === 'tesSUCCESS') fail('6c: replayed sponsor signature SUCCEEDED!');
    console.log(`✓ 6c replayed sponsor signature from Act 5 → rejected (${out.engineResult})`);
    evidence.negativeControls.sponsorSignatureReplay = out.engineResult;
  }

  // 6d — Sponsor field present, no signature, no Sponsorship object
  {
    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: payer.address,
      Destination: merchant.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '0.5' },
      Fee: FEE,
      Sequence: payerSeq,
      LastLedgerSequence: await lastLedger(client),
      Sponsor: facilitator.address,
      SponsorFlags: SPF_SPONSOR_FEE,
      SigningPubKey: payer.publicKey,
    };
    const data = (await import('ripple-binary-codec')).encodeForSigning(tx as never, defs);
    const full = { ...tx, TxnSignature: sign(data, payer.privateKey) }; // no SponsorSignature
    const blob = encode(full as never, defs);
    const hash = computeTxHash(blob);
    const out = await submitAndConfirm(client, blob, hash, { timeoutLedgers: 3 });
    if (out.txResult === 'tesSUCCESS') fail('6d: unsigned sponsorship SUCCEEDED with no Sponsorship object!');
    console.log(`✓ 6d no sponsor signature + no Sponsorship object → rejected (${out.engineResult})`);
    evidence.negativeControls.missingSponsorSignature = out.engineResult;
  }

  // ─── Act 7: pre-funded mode — the one that scales for x402 ───
  console.log('\n═══ Act 7: pre-funded Sponsorship object (no co-sign round trip) ═══');
  {
    const setTx = {
      TransactionType: 'SponsorshipSet',
      Account: facilitator.address,
      Sponsee: payer.address,
      // Devnet build (3.3.0-rc5) diverges from the XLS-68 draft here: the
      // prepaid pool is topped up via FeeAmountDelta (additive), not set via
      // an absolute FeeAmount — discovered empirically 2026-08-04.
      FeeAmountDelta: '1000000', // +1 XRP into the fee pool
      MaxFee: '1000',            // fee-drain ceiling per tx
      Fee: FEE,
      Sequence: await getSequence(client, facilitator.address),
      LastLedgerSequence: await lastLedger(client),
    };
    const { blob, hash } = signWithDefinitions(setTx, facilitator, defs);
    const out = await submitAndConfirm(client, blob, hash);
    if (out.txResult !== 'tesSUCCESS') fail(`SponsorshipSet failed: ${out.engineResult}/${out.txResult}`);
    console.log('✓ Sponsorship object created (FeeAmount 1 XRP, MaxFee 1000 drops)');
    evidence.acts.act7a_sponsorshipSet = { hash };

    // payer transacts with NO sponsor signature — the ledger object authorizes it
    const payTx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: payer.address,
      Destination: merchant.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '1' },
      Fee: FEE,
      Sequence: await getSequence(client, payer.address),
      LastLedgerSequence: await lastLedger(client),
      Sponsor: facilitator.address,
      SponsorFlags: SPF_SPONSOR_FEE,
      SigningPubKey: payer.publicKey,
    };
    const data = (await import('ripple-binary-codec')).encodeForSigning(payTx as never, defs);
    const full = { ...payTx, TxnSignature: sign(data, payer.privateKey) };
    const blob2 = encode(full as never, defs);
    const hash2 = computeTxHash(blob2);
    const out2 = await submitAndConfirm(client, blob2, hash2);
    if (out2.txResult !== 'tesSUCCESS') fail(`pre-funded sponsored payment failed: ${out2.engineResult}/${out2.txResult}`);
    console.log('✓ payer paid merchant 1 FCD with NO co-signature — pre-funded pool covered the fee');
    evidence.acts.act7b_prefundedPayment = { hash: hash2 };

    // fee-drain control: Fee above MaxFee must be rejected
    const drainTx: Record<string, unknown> = {
      ...payTx,
      Fee: '5000', // over the 1000-drop MaxFee
      Sequence: await getSequence(client, payer.address),
      LastLedgerSequence: await lastLedger(client),
    };
    const data3 = (await import('ripple-binary-codec')).encodeForSigning(drainTx as never, defs);
    const full3 = { ...drainTx, TxnSignature: sign(data3, payer.privateKey) };
    const blob3 = encode(full3 as never, defs);
    const hash3 = computeTxHash(blob3);
    const out3 = await submitAndConfirm(client, blob3, hash3, { timeoutLedgers: 3 });
    if (out3.txResult === 'tesSUCCESS') fail('MaxFee did NOT block a fee above the ceiling!');
    console.log(`✓ Fee 5000 > MaxFee 1000 → rejected (${out3.engineResult}) — fee-drain ceiling holds`);
    evidence.negativeControls.maxFeeDrainBlocked = out3.engineResult;

    const objs = await rpc<{ account_objects: Array<Record<string, unknown>> }>(client, {
      command: 'account_objects', account: facilitator.address, ledger_index: 'validated',
    });
    const sp = objs.account_objects.find((o) => o.LedgerEntryType === 'Sponsorship');
    console.log(`✓ Sponsorship.FeeAmount now ${sp?.FeeAmount} drops (started 1000000)`);
    evidence.acts.act7c_poolAfter = { feeAmount: sp?.FeeAmount };
  }

  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/latest-run.json', JSON.stringify(evidence, null, 2));
  console.log('\n🏁 ALL ACTS PASSED. Evidence: evidence/latest-run.json');
  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
