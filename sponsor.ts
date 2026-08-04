/**
 * XLS-68 Sponsored Fees & Reserves — Devnet prototype helpers.
 *
 * The `Sponsor` amendment (ID BE1F90581635DBCEBFC4678C4B54FEDDC1A17B50FD02CFE765A4132A342126AC)
 * is live on XRPL Devnet only. Standard xrpl.js definitions do not know the
 * sponsor fields, so all encoding here goes through XrplDefinitions built from
 * the network's own `server_definitions` response.
 *
 * Signing scheme (verified against rippled PR #5887 / STTx::checkSingleSign):
 * the sponsor signs THE SAME bytes as the sponsee — the `STX\0`-prefixed
 * serialization of all signing fields (which includes Sponsor, SponsorFlags,
 * and the sponsee's top-level SigningPubKey; excludes TxnSignature and
 * SponsorSignature). Both signatures therefore bind every payment term:
 * neither party can alter the transaction after the other has signed.
 */
import { createHash } from 'crypto';
import type { Client, Wallet } from 'xrpl';
import { XrplDefinitions, encode, encodeForSigning } from 'ripple-binary-codec';
import { sign } from 'ripple-keypairs';

export const SPONSOR_AMENDMENT_ID =
  'BE1F90581635DBCEBFC4678C4B54FEDDC1A17B50FD02CFE765A4132A342126AC';

/** SponsorFlags values (XLS-68 §8.1.1) */
export const SPF_SPONSOR_FEE = 0x00000001;
export const SPF_SPONSOR_RESERVE = 0x00000002;

/** Payment flag: create the destination account with tx.Account as its reserve sponsor (§11.2) */
export const TF_SPONSOR_CREATED_ACCOUNT = 0x00080000;

/** Amendments ledger object (singleton) */
export const AMENDMENTS_INDEX =
  '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';

export interface SponsorSignatureObject {
  SigningPubKey: string;
  TxnSignature: string;
}

const definitionsCache = new Map<string, XrplDefinitions>();

/** Build XrplDefinitions from the connected network's own server_definitions. */
export async function loadNetworkDefinitions(client: Client): Promise<XrplDefinitions> {
  const url = client.url ?? 'default';
  const cached = definitionsCache.get(url);
  if (cached) return cached;
  const res = await client.request({ command: 'server_definitions' } as never);
  const defs = new XrplDefinitions((res as { result: never }).result);
  definitionsCache.set(url, defs);
  return defs;
}

/** True if the Sponsor amendment is enabled on the connected network. */
export async function isSponsorAmendmentEnabled(client: Client): Promise<boolean> {
  const res = await client.request({
    command: 'ledger_entry',
    index: AMENDMENTS_INDEX,
    ledger_index: 'validated',
  } as never);
  const node = (res as { result: { node?: { Amendments?: string[] } } }).result.node;
  return (node?.Amendments ?? []).includes(SPONSOR_AMENDMENT_ID);
}

/** Transaction hash = SHA512Half over the TXN\0 prefix + full signed blob. */
export function computeTxHash(signedBlobHex: string): string {
  const digest = createHash('sha512')
    .update(Buffer.from('54584E00' + signedBlobHex, 'hex'))
    .digest();
  return digest.subarray(0, 32).toString('hex').toUpperCase();
}

/**
 * The canonical signing payload for a sponsored transaction. The tx JSON must
 * already carry the sponsee's SigningPubKey — it is a signing field, so the
 * sponsor's signature covers it too.
 */
export function sponsoredSigningData(
  txJson: Record<string, unknown>,
  defs: XrplDefinitions,
): string {
  if (!txJson.SigningPubKey) {
    throw new Error('sponsoredSigningData: set the sponsee SigningPubKey before signing');
  }
  return encodeForSigning(txJson as never, defs);
}

/** Sponsor co-signs the fully-formed tx and returns the SponsorSignature object. */
export function sponsorCoSign(
  txJson: Record<string, unknown>,
  sponsorWallet: Wallet,
  defs: XrplDefinitions,
): SponsorSignatureObject {
  const data = sponsoredSigningData(txJson, defs);
  return {
    SigningPubKey: sponsorWallet.publicKey,
    TxnSignature: sign(data, sponsorWallet.privateKey),
  };
}

/** Sponsee signs and the tx is assembled into a submittable blob. */
export function finalizeSponsored(
  txJson: Record<string, unknown>,
  sponsorSignature: SponsorSignatureObject,
  sponseeWallet: Wallet,
  defs: XrplDefinitions,
): { blob: string; hash: string } {
  const data = sponsoredSigningData(txJson, defs);
  const full = {
    ...txJson,
    TxnSignature: sign(data, sponseeWallet.privateKey),
    SponsorSignature: sponsorSignature,
  };
  const blob = encode(full as never, defs);
  return { blob, hash: computeTxHash(blob) };
}

/** Single-signer path for tx types the standard definitions don't know (e.g. SponsorshipSet). */
export function signWithDefinitions(
  txJson: Record<string, unknown>,
  wallet: Wallet,
  defs: XrplDefinitions,
): { blob: string; hash: string } {
  const prepared = { ...txJson, SigningPubKey: wallet.publicKey };
  const data = encodeForSigning(prepared as never, defs);
  const full = { ...prepared, TxnSignature: sign(data, wallet.privateKey) };
  const blob = encode(full as never, defs);
  return { blob, hash: computeTxHash(blob) };
}

export interface SubmitOutcome {
  engineResult: string;
  validated: boolean;
  txResult?: string | undefined;
  hash: string;
}

/**
 * Submit a signed blob and wait for validation. Uses raw commands throughout so
 * xrpl.js never tries to decode sponsor fields with its bundled definitions.
 */
export async function submitAndConfirm(
  client: Client,
  blob: string,
  hash: string,
  { timeoutLedgers = 20 }: { timeoutLedgers?: number } = {},
): Promise<SubmitOutcome> {
  let engineResult: string;
  try {
    const sub = await client.request({ command: 'submit', tx_blob: blob } as never);
    engineResult = (sub as { result: { engine_result?: string } }).result.engine_result ?? 'unknown';
  } catch (e) {
    // invalid signatures die at rippled's local checks — submit throws
    // (error_exception e.g. "fails local checks: Sponsor: Invalid signature.")
    // before the tx is ever relayed. Strongest rejection there is.
    const data = (e as { data?: { error_exception?: string; error?: string } }).data;
    return { engineResult: `LOCAL_REJECT: ${data?.error_exception ?? data?.error ?? String(e)}`, validated: false, hash };
  }
  if (!engineResult.startsWith('tes') && !engineResult.startsWith('ter') && !engineResult.startsWith('tec')) {
    return { engineResult, validated: false, hash };
  }
  for (let i = 0; i < timeoutLedgers; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await client.request({ command: 'tx', transaction: hash } as never);
      const result = (res as {
        result: { validated?: boolean; meta?: { TransactionResult?: string } };
      }).result;
      if (result.validated) {
        return {
          engineResult,
          validated: true,
          txResult: result.meta?.TransactionResult,
          hash,
        };
      }
    } catch {
      // txnNotFound until it appears in a ledger — keep polling
    }
  }
  return { engineResult, validated: false, hash };
}
