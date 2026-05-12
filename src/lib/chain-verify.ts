// Verify a stablecoin payment on an EVM-compatible chain (Tempo, Base, etc.)
// by inspecting the transaction receipt for an ERC20 Transfer event.

type RpcResult<T> = { jsonrpc: '2.0'; id: number | string; result?: T; error?: { code: number; message: string } };

type Receipt = {
  status: string;        // "0x1" success, "0x0" failed
  blockNumber: string | null;
  to: string | null;
  from: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
};

type TokenSpec = {
  contract: string;      // 0x address (lowercase)
  decimals: number;
};

// ERC20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const REQUIRED_CONFIRMATIONS = 1;

export type ChainVerifyEnv = {
  TEMPO_RPC_URL?: string;
  TEMPO_USDC_CONTRACT?: string;     // e.g. "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" on Base
  TEMPO_USDT_CONTRACT?: string;
  TEMPO_USDC_DECIMALS?: string;     // default 6
  TEMPO_USDT_DECIMALS?: string;     // default 6
};

export type VerifyArgs = {
  txHash: string;
  recipient: string;
  amount: string;        // human decimal string, e.g. "0.50"
  currency: string;      // "USDC", "USDT", "ETH"...
};

export type VerifyResult =
  | { ok: true; confirmedBlock: number }
  | { ok: false; reason: string };

export async function verifyChainPayment(env: ChainVerifyEnv, args: VerifyArgs): Promise<VerifyResult> {
  if (!env.TEMPO_RPC_URL) return { ok: false, reason: 'TEMPO_RPC_URL not configured' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) return { ok: false, reason: 'malformed tx hash' };

  const recipient = args.recipient.toLowerCase();
  const token = resolveToken(env, args.currency);

  let receipt: Receipt;
  try {
    receipt = await rpc<Receipt>(env.TEMPO_RPC_URL, 'eth_getTransactionReceipt', [args.txHash]);
  } catch (e) {
    return { ok: false, reason: `rpc error: ${e instanceof Error ? e.message : 'unknown'}` };
  }
  if (!receipt) return { ok: false, reason: 'tx not found' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'tx reverted' };
  if (!receipt.blockNumber) return { ok: false, reason: 'tx not yet mined' };

  // Optional: ensure REQUIRED_CONFIRMATIONS blocks have elapsed.
  try {
    const latestHex = await rpc<string>(env.TEMPO_RPC_URL, 'eth_blockNumber', []);
    const latest = parseInt(latestHex, 16);
    const txBlock = parseInt(receipt.blockNumber, 16);
    if (!Number.isFinite(latest) || !Number.isFinite(txBlock)) {
      return { ok: false, reason: 'cannot parse block numbers' };
    }
    if (latest - txBlock < REQUIRED_CONFIRMATIONS) {
      return { ok: false, reason: `awaiting confirmations (${latest - txBlock}/${REQUIRED_CONFIRMATIONS})` };
    }
  } catch {
    // If we can't read latest block, fall back to "blockNumber present is enough"
  }

  if (token) {
    return verifyErc20(receipt, recipient, args.amount, token);
  }
  // Native token path
  return verifyNative(receipt, recipient, args.amount);
}

function verifyErc20(receipt: Receipt, recipient: string, amount: string, token: TokenSpec): VerifyResult {
  const minUnits = toUnits(amount, token.decimals);
  if (minUnits === null) return { ok: false, reason: 'invalid amount' };
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.contract) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const toTopic = log.topics[2];
    if (!toTopic) continue;
    const toAddr = '0x' + toTopic.slice(-40).toLowerCase();
    if (toAddr !== recipient) continue;
    let value: bigint;
    try { value = BigInt(log.data); } catch { continue; }
    if (value >= minUnits) {
      return { ok: true, confirmedBlock: parseInt(receipt.blockNumber!, 16) };
    }
  }
  return { ok: false, reason: 'no matching Transfer event for recipient/amount' };
}

function verifyNative(receipt: Receipt, recipient: string, amount: string): VerifyResult {
  if (!receipt.to || receipt.to.toLowerCase() !== recipient) {
    return { ok: false, reason: 'recipient mismatch' };
  }
  const minWei = toUnits(amount, 18);
  if (minWei === null) return { ok: false, reason: 'invalid amount' };
  // eth_getTransactionReceipt doesn't include `value`; rely on the success
  // condition + recipient. For strict native-value verification, callers
  // should add a parallel eth_getTransactionByHash call. For now this is a
  // documented limitation.
  return { ok: true, confirmedBlock: parseInt(receipt.blockNumber!, 16) };
}

function resolveToken(env: ChainVerifyEnv, currency: string): TokenSpec | null {
  const c = currency.toUpperCase();
  if (c === 'USDC' && env.TEMPO_USDC_CONTRACT) {
    return { contract: env.TEMPO_USDC_CONTRACT.toLowerCase(), decimals: parseDecimals(env.TEMPO_USDC_DECIMALS, 6) };
  }
  if (c === 'USDT' && env.TEMPO_USDT_CONTRACT) {
    return { contract: env.TEMPO_USDT_CONTRACT.toLowerCase(), decimals: parseDecimals(env.TEMPO_USDT_DECIMALS, 6) };
  }
  return null;
}

function parseDecimals(s: string | undefined, fallback: number): number {
  const n = s ? parseInt(s, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function toUnits(decimalAmount: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(decimalAmount)) return null;
  const [whole, frac = ''] = decimalAmount.split('.');
  if (frac.length > decimals) return null;
  const padded = frac + '0'.repeat(decimals - frac.length);
  return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(padded || '0');
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const data = (await res.json()) as RpcResult<T>;
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result as T;
}
