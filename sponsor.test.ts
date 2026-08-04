/**
 * XLS-68 sponsor helpers — offline tests.
 *
 * Definitions come from a vendored Devnet server_definitions fixture
 * (devnet-definitions.json, captured 2026-08-04) so no
 * network is needed. The binding tests mirror the Devnet negative controls in
 * scripts/xrpl-sponsor-prototype.ts: any mutation after signing must
 * invalidate the corresponding signature.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { Wallet, hashes } from 'xrpl';
import { XrplDefinitions, encode, decode, encodeForSigning } from 'ripple-binary-codec';
import { verify } from 'ripple-keypairs';
import {
  SPONSOR_AMENDMENT_ID,
  SPF_SPONSOR_FEE,
  SPF_SPONSOR_RESERVE,
  TF_SPONSOR_CREATED_ACCOUNT,
  computeTxHash,
  sponsorCoSign,
  finalizeSponsored,
  sponsoredSigningData,
} from './sponsor.js';

const defs = new XrplDefinitions(
  JSON.parse(readFileSync('devnet-definitions.json', 'utf-8')),
);

const sponsor = Wallet.fromSeed('sEdTM1uX8pu2do5XvTnutH6HsouMaM2'); // throwaway test seed
const payer = Wallet.fromSeed('sEd7rBGm5kxzauRTAV2hbsNz7N45X91');  // throwaway test seed

function baseTx(): Record<string, unknown> {
  return {
    TransactionType: 'Payment',
    Account: payer.address,
    Destination: sponsor.address,
    Amount: { currency: 'FCD', issuer: sponsor.address, value: '2.5' },
    Fee: '12',
    Sequence: 7,
    LastLedgerSequence: 1000,
    Sponsor: sponsor.address,
    SponsorFlags: SPF_SPONSOR_FEE,
    SigningPubKey: payer.publicKey,
  };
}

function sha512half(data: Buffer): string {
  return createHash('sha512').update(data).digest().subarray(0, 32).toString('hex').toUpperCase();
}

describe('amendment IDs', () => {
  it('SPONSOR_AMENDMENT_ID is SHA512Half of the feature name', () => {
    expect(sha512half(Buffer.from('Sponsor'))).toBe(SPONSOR_AMENDMENT_ID);
  });

  it('flag constants match XLS-68', () => {
    expect(SPF_SPONSOR_FEE).toBe(1);
    expect(SPF_SPONSOR_RESERVE).toBe(2);
    expect(TF_SPONSOR_CREATED_ACCOUNT).toBe(0x00080000);
  });
});

describe('computeTxHash', () => {
  it('matches xrpl.js hashSignedTx for a standard signed transaction', () => {
    const signed = payer.sign({
      TransactionType: 'Payment',
      Account: payer.address,
      Destination: sponsor.address,
      Amount: '1000',
      Fee: '12',
      Sequence: 1,
    });
    expect(computeTxHash(signed.tx_blob)).toBe(hashes.hashSignedTx(signed.tx_blob));
  });
});

describe('sponsored transaction encoding', () => {
  it('encodes sponsor fields and survives an encode/decode roundtrip', () => {
    const tx = baseTx();
    const sig = sponsorCoSign(tx, sponsor, defs);
    const { blob } = finalizeSponsored(tx, sig, payer, defs);
    const back = decode(blob, defs) as Record<string, unknown>;
    expect(back.Sponsor).toBe(sponsor.address);
    expect(back.SponsorFlags).toBe(SPF_SPONSOR_FEE);
    const ss = back.SponsorSignature as Record<string, string>;
    expect(ss.SigningPubKey).toBe(sponsor.publicKey);
    expect(ss.TxnSignature).toBe(sig.TxnSignature);
  });

  it('SponsorSignature and TxnSignature are excluded from the signing payload', () => {
    const tx = baseTx();
    const before = sponsoredSigningData(tx, defs);
    const sig = sponsorCoSign(tx, sponsor, defs);
    const withSigs = {
      ...tx,
      TxnSignature: 'DEADBEEF',
      SponsorSignature: sig,
    };
    expect(encodeForSigning(withSigs as never, defs)).toBe(before);
  });

  it('refuses to build signing data without the sponsee SigningPubKey', () => {
    const tx = baseTx();
    delete tx.SigningPubKey;
    expect(() => sponsoredSigningData(tx, defs)).toThrow(/SigningPubKey/);
  });
});

describe('the binding property (mirrors Devnet negative controls)', () => {
  it('both signatures verify over the identical signing payload', () => {
    const tx = baseTx();
    const data = sponsoredSigningData(tx, defs);
    const sponsorSig = sponsorCoSign(tx, sponsor, defs);
    const { blob } = finalizeSponsored(tx, sponsorSig, payer, defs);
    const back = decode(blob, defs) as Record<string, unknown>;
    const backSponsorSig = (back.SponsorSignature as Record<string, string>).TxnSignature as string;
    expect(verify(data, backSponsorSig, sponsor.publicKey)).toBe(true);
    expect(verify(data, back.TxnSignature as string, payer.publicKey)).toBe(true);
  });

  it('sponsee tampering with the Fee after the sponsor signed kills the sponsor signature', () => {
    const tx = baseTx();
    const sponsorSig = sponsorCoSign(tx, sponsor, defs);
    const tampered = { ...tx, Fee: '5000000' };
    const tamperedData = sponsoredSigningData(tampered, defs);
    expect(verify(tamperedData, sponsorSig.TxnSignature, sponsor.publicKey)).toBe(false);
  });

  it('sponsor altering the Amount after the sponsee signed kills the sponsee signature', () => {
    const tx = baseTx();
    const sponsorSig = sponsorCoSign(tx, sponsor, defs);
    const { blob } = finalizeSponsored(tx, sponsorSig, payer, defs);
    const sponseeSig = (decode(blob, defs) as Record<string, unknown>).TxnSignature as string;
    const altered = { ...tx, Amount: { currency: 'FCD', issuer: sponsor.address, value: '9.99' } };
    const alteredData = sponsoredSigningData(altered, defs);
    expect(verify(alteredData, sponseeSig, payer.publicKey)).toBe(false);
  });

  it('a sponsor signature cannot be replayed on a different Sequence', () => {
    const tx = baseTx();
    const sponsorSig = sponsorCoSign(tx, sponsor, defs);
    const nextTx = { ...tx, Sequence: 8 };
    const nextData = sponsoredSigningData(nextTx, defs);
    expect(verify(nextData, sponsorSig.TxnSignature, sponsor.publicKey)).toBe(false);
  });
});

describe('fixture sanity', () => {
  it('fixture definitions know the sponsorship transaction types', () => {
    const tx = {
      TransactionType: 'SponsorshipSet',
      Account: sponsor.address,
      Sponsee: payer.address,
      FeeAmount: '1000000',
      MaxFee: '1000',
      Fee: '12',
      Sequence: 3,
      SigningPubKey: sponsor.publicKey,
    };
    const blob = encode(tx as never, defs);
    const back = decode(blob, defs) as Record<string, unknown>;
    expect(back.TransactionType).toBe('SponsorshipSet');
    expect(back.FeeAmount).toBe('1000000');
  });
});
