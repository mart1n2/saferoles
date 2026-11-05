/**
 * Fetches a Roles modifier's event logs, and the annotation posts about it.
 *
 * A first read comes from the cheapest source that serves the chain: Etherscan
 * when the user has a key and the chain is on their plan, Blockscout (with the
 * user's key, or a public instance that answers without one), and otherwise
 * the chain's RPC in block ranges sized to what the node accepts. Logs older
 * than the last `TAIL_BLOCKS` are treated as final and cached locally. Later
 * reads, including the check right before signing, fetch only what is new and
 * ask the RPC first, since explorers can lag the chain by a few blocks; an
 * explorer serves them only when the RPC refuses log queries. Keyless
 * explorer budgets are small (Blockscout: 10 calls per IP per network, reset
 * after most of an hour), so they are spent on cold history, not on reloads.
 */
import { getAddress, zeroPadValue } from "ethers";
import { ANNOTATION_TAG_TOPIC, NEW_POST_TOPIC, POSTER_ADDRESS, rolesEvents, type RawLog } from "./roles-replay";

export type LogQuery = {
  address: string;
  /** Topic filters by position; null leaves a position open. */
  topics?: (string | null)[];
  fromBlock: number;
  toBlock: number;
};

export interface LogSource {
  readonly name: string;
  getLogs(query: LogQuery, signal?: AbortSignal): Promise<RawLog[]>;
}

/** The source cannot serve this chain (no key, not on the plan): try the next one. */
export class SourceUnavailable extends Error {}

/**
 * Reading the range from the RPC would take more requests than is reasonable
 * for a page load, at the block span the node accepts.
 */
export class HistoryTooLong extends Error {
  constructor(readonly requests: number) {
    super(`Reading this history from the RPC would take about ${requests} requests.`);
    this.name = "HistoryTooLong";
  }
}

/**
 * No source can serve the history right now: the explorers are unavailable
 * (`rateLimited` when one has spent its budget) and the RPC keeps no history.
 */
export class HistoryUnavailable extends Error {
  constructor(readonly rateLimited: boolean, options?: ErrorOptions) {
    super("No source can serve this modifier's history right now.", options);
    this.name = "HistoryUnavailable";
  }
}

/** The block-range limit a node names in its error, in the phrasings seen in the wild. */
export function namedSpanLimit(message: string): number | null {
  const match =
    message.match(/only (\d{3,9})(?: blocks)? (?:are )?allowed/i) ??
    message.match(/(?:max(?:imum)?(?: block)? range|max(?:imum)? of|limit of)[^0-9]{0,20}(\d{3,9})/i);
  return match ? Number(match[1]) : null;
}

export type RpcRequest = (method: string, params: unknown[], signal?: AbortSignal) => Promise<unknown>;

/** Blocks behind the tip that are never cached unless already finalized, since they may still be reorged. */
export const TAIL_BLOCKS = 1_000;
/** A gap since the last read up to this many blocks is read in one RPC-first request. */
export const RECENT_BLOCKS = 50_000;
/** Explorers return at most this many logs per call; a full page means the range must be split. */
const EXPLORER_PAGE = 1_000;

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

function quantity(value: unknown, field: string): number {
  // Etherscan returns "0x" for a zero log index.
  if (value === "0x") return 0;
  const parsed = typeof value === "string" ? Number(value.startsWith("0x") ? BigInt(value) : value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Malformed log ${field}.`);
  return parsed;
}

function hex(value: unknown, field: string, bytes?: number): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value) || (bytes !== undefined && value.length !== 2 + bytes * 2)) {
    throw new Error(`Malformed log ${field}.`);
  }
  return value.toLowerCase();
}

/** Validates one log from any source; a log for another address is a source error. */
export function parseLog(value: unknown, expectedAddress: string): RawLog {
  if (!value || typeof value !== "object") throw new Error("Malformed log.");
  const row = value as Record<string, unknown>;
  const address = hex(row.address, "address", 20);
  if (address !== expectedAddress.toLowerCase()) throw new Error("A log source returned a log for another contract.");
  if (!Array.isArray(row.topics) || row.topics.length > 4) throw new Error("Malformed log topics.");
  // Blockscout pads `topics` to four entries with nulls; only trailing ones are padding.
  const topics = [...row.topics];
  while (topics.length && topics.at(-1) === null) topics.pop();
  return {
    address,
    topics: topics.map((topic) => hex(topic, "topic", 32)),
    data: hex(row.data, "data"),
    blockNumber: quantity(row.blockNumber, "block number"),
    logIndex: quantity(row.logIndex, "log index"),
    transactionHash: hex(row.transactionHash, "transaction hash", 32),
  };
}

/**
 * An Etherscan-compatible explorer API (Etherscan v2 or Blockscout).
 *
 * `params` carries what the explorer needs on every call, such as `chainid`
 * and `apikey`. Calls are spaced by `minInterval` to stay under rate limits.
 */
export function explorerSource({
  name,
  url,
  params,
  fetcher = fetch,
  minInterval = 0,
}: {
  name: string;
  url: string;
  params: Record<string, string>;
  fetcher?: typeof fetch;
  minInterval?: number;
}): LogSource {
  let nextCall = 0;
  async function call(query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      if (nextCall > now) await wait(nextCall - now, signal);
      nextCall = Date.now() + minInterval;
      const search = new URLSearchParams({ ...params, ...query });
      const timeout = AbortSignal.timeout(20_000);
      const response = await fetcher(`${url}?${search}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      // Etherscan reports a rate limit in the body, Blockscout as HTTP 429. A
      // spent budget (keyless Blockscout: 10 calls per IP, reset after most of
      // an hour) is not worth waiting for; move on to the next source.
      if (response.status === 429) {
        if (response.headers.get("x-ratelimit-remaining") === "0" || attempt >= 3) {
          throw new SourceUnavailable(`${name} is rate limited for now.`);
        }
        await wait(1_000 * (attempt + 1), signal);
        continue;
      }
      if (!response.ok) throw new Error(`${name} returned ${response.status}.`);
      const body = (await response.json()) as { status?: unknown; message?: unknown; result?: unknown };
      if (body.status === "1") return body.result;
      const detail = `${typeof body.result === "string" ? body.result : ""} ${typeof body.message === "string" ? body.message : ""}`;
      // Etherscan says "No records found", Blockscout "No logs found".
      if (/no (?:records|logs) found/i.test(detail)) return [];
      if (/rate limit/i.test(detail) && attempt < 4) {
        await wait(1_000 * (attempt + 1), signal);
        continue;
      }
      if (/not supported|paid plan|api pro|upgrade|invalid api key|missing\/invalid|apikey/i.test(detail)) {
        throw new SourceUnavailable(`${name}: ${detail.trim()}`);
      }
      throw new Error(`${name}: ${detail.trim() || "unexpected response"}`);
    }
  }

  async function range(query: LogQuery, signal?: AbortSignal): Promise<RawLog[]> {
    const filters: Record<string, string> = {
      module: "logs",
      action: "getLogs",
      address: query.address,
      fromBlock: String(query.fromBlock),
      toBlock: String(query.toBlock),
      page: "1",
      offset: String(EXPLORER_PAGE),
    };
    const topics = query.topics ?? [];
    // Every pair of given topics is combined with "and": Blockscout requires an
    // operator for each pair (topic0_2_opr too), Etherscan accepts them all.
    const given = topics.flatMap((topic, index) => (topic === null ? [] : [index]));
    for (const index of given) filters[`topic${index}`] = topics[index]!;
    for (const [n, low] of given.entries()) {
      for (const high of given.slice(n + 1)) filters[`topic${low}_${high}_opr`] = "and";
    }
    const result = await call(filters, signal);
    if (!Array.isArray(result)) throw new Error(`${name} returned malformed logs.`);
    if (result.length >= EXPLORER_PAGE) {
      if (query.fromBlock === query.toBlock) throw new Error(`${name} returned too many logs for one block.`);
      const middle = Math.floor((query.fromBlock + query.toBlock) / 2);
      return [
        ...(await range({ ...query, toBlock: middle }, signal)),
        ...(await range({ ...query, fromBlock: middle + 1 }, signal)),
      ];
    }
    return result.map((log) => parseLog(log, query.address));
  }

  return { name, getLogs: range };
}

/**
 * eth_getLogs over a range, split into spans the node accepts. A rejected span
 * shrinks (to the limit the error names, when it names one) and never grows
 * past it again; a successful one grows, so a permissive node is asked few
 * times. When the rest of the range would need more than `maxRequests` calls
 * at the current span, it stops with HistoryTooLong instead of grinding on.
 */
export function rpcSource({
  request,
  name = "RPC",
  initialSpan = 1_000_000,
  // Some nodes accept far more for an address-filtered query than for a topic
  // search (Arbitrum's public RPC: 10M blocks against 30k), so only a node's
  // own error sets the limit.
  maxSpan = 100_000_000,
  minSpan = 100,
  maxRequests = 300,
  memory,
}: {
  request: RpcRequest;
  name?: string;
  initialSpan?: number;
  maxSpan?: number;
  minSpan?: number;
  maxRequests?: number;
  /** Keeps learned spans across page loads, so a node's limit is not probed again. */
  memory?: SpanMemory;
}): LogSource {
  // Nodes limit query shapes differently (an address alone against an address
  // with topics), so each shape keeps what it has learned.
  const learned = new Map<string, { span: number; ceiling: number }>();
  // Set once the node has kept refusing log queries; later calls fail at once.
  let refusing: unknown = null;
  return {
    name,
    async getLogs(query, signal) {
      if (refusing) throw refusing;
      const shape = (query.topics ?? []).map((topic) => (topic === null ? "_" : "t")).join("");
      let { span, ceiling } = learned.get(shape) ?? memory?.load(shape) ?? { span: initialSpan, ceiling: maxSpan };
      const remember = () => {
        learned.set(shape, { span, ceiling });
        memory?.save(shape, { span, ceiling });
      };
      const logs: RawLog[] = [];
      let from = query.fromBlock;
      let failures = 0;
      let calls = 0;
      while (from <= query.toBlock) {
        // After one call has shown what the node accepts; optimistic, at the
        // widest span it may still allow.
        const remaining = Math.ceil((query.toBlock - from + 1) / ceiling);
        if (calls > 0 && calls + remaining > maxRequests) throw new HistoryTooLong(calls + remaining);
        calls++;
        signal?.throwIfAborted();
        const to = Math.min(query.toBlock, from + span - 1);
        try {
          const result = await request("eth_getLogs", [{
            address: query.address,
            topics: query.topics,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          }], signal);
          if (!Array.isArray(result)) throw new Error(`${name} returned malformed logs.`);
          logs.push(...result.map((log) => parseLog(log, query.address)));
          from = to + 1;
          failures = 0;
          span = Math.min(ceiling, span * 2);
          remember();
        } catch (error) {
          if (signal?.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const named = namedSpanLimit(message);
          // A rate limit is waited out; the message also quotes the request
          // body, so it is told apart by status and wording, not by "block".
          if (named === null && /\b429\b|request limit reached|too many requests|rate limit/i.test(message)) {
            if (failures >= 2) {
              refusing = error;
              throw error;
            }
            failures++;
            await wait(1_000 * failures, signal);
            continue;
          }
          // A node without history refuses old ranges at any size.
          if (/archive|historical state|missing trie node|pruned/i.test(message)) throw error;
          // Shrink from the range actually tried, which may be far below `span`.
          const tried = to - from + 1;
          if (tried <= minSpan) throw error;
          const limit = named !== null && named < tried ? named : null;
          ceiling = Math.max(minSpan, limit ?? Math.floor(tried / 2));
          span = Math.max(minSpan, limit ?? Math.floor(tried / 4));
          remember();
        }
      }
      return logs;
    },
  };
}

export type SpanMemory = {
  load(shape: string): { span: number; ceiling: number } | null;
  save(shape: string, value: { span: number; ceiling: number }): void;
};

/** The first block at which `address` has code, by bisecting eth_getCode; null if the node cannot answer for old blocks. */
export async function findCreationBlock(
  request: RpcRequest,
  address: string,
  low: number,
  high: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const hasCode = async (block: number) => {
    const code = await request("eth_getCode", [address, `0x${block.toString(16)}`], signal);
    return typeof code === "string" && code !== "0x";
  };
  try {
    if (!(await hasCode(high))) return null;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (await hasCode(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  } catch {
    return null;
  }
}

type Stream = { syncedTo: number; logs: RawLog[] };
export type LogCacheEntry = {
  version: 1;
  /** No log for this modifier exists before this block. */
  from: number;
  modifier: Stream;
  /** Annotation posts, per owner the modifier has had. */
  posts: Record<string, Stream>;
};
export type LogCache = {
  read(key: string): Promise<LogCacheEntry | undefined>;
  write(key: string, entry: LogCacheEntry): Promise<void>;
};

function isStream(value: unknown): value is Stream {
  const stream = value as Stream | null;
  return Boolean(stream && Number.isSafeInteger(stream.syncedTo) && Array.isArray(stream.logs));
}

/** Rejects a cached record of another shape instead of trusting it. */
export function validCacheEntry(value: unknown): LogCacheEntry | undefined {
  const entry = value as LogCacheEntry | null;
  if (!entry || entry.version !== 1 || !Number.isSafeInteger(entry.from) || !isStream(entry.modifier)) return undefined;
  if (!entry.posts || typeof entry.posts !== "object" || !Object.values(entry.posts).every(isStream)) return undefined;
  return entry;
}

export type ModifierLogOptions = {
  chainId: number;
  address: string;
  /** Explorer sources, cheapest first. The RPC is the last resort and the only source for the tail. */
  explorers: LogSource[];
  rpc: LogSource;
  request: RpcRequest;
  cache?: LogCache;
  /** Lowest block a modifier on this chain can have been created at. */
  floor: number;
  /** Finds the creation block faster than bisecting, e.g. through an explorer. */
  creationBlock?: () => Promise<number | null>;
  signal?: AbortSignal;
};

/**
 * Every log the replay needs, in chain order: the modifier's own, and the
 * annotation posts its owners made. Owners are found from the modifier's logs
 * themselves, since a post only counts when it came from the owner of the time.
 */
export async function readModifierLogs(options: ModifierLogOptions): Promise<RawLog[]> {
  const { chainId, explorers, rpc, request, cache, signal } = options;
  const address = getAddress(options.address).toLowerCase();
  const cacheKey = `${chainId}:${address}`;
  const latest = Number(BigInt(String(await request("eth_blockNumber", [], signal))));
  // Logs up to `head` are cached. A finalized block cannot be reorged, and on
  // most chains it is far closer to the tip than TAIL_BLOCKS, so fewer blocks
  // are read again on every load; a node without the tag keeps the margin.
  const finalized = await request("eth_getBlockByNumber", ["finalized", false], signal)
    .then((block) => Number(BigInt(String((block as { number?: unknown } | null)?.number))))
    .catch(() => Number.NaN);
  const head = Math.max(0, latest - TAIL_BLOCKS, Number.isSafeInteger(finalized) && finalized <= latest ? finalized : 0);

  let entry: LogCacheEntry | undefined;
  try {
    entry = validCacheEntry(await cache?.read(cacheKey));
  } catch {
    entry = undefined;
  }
  // Whether `entry.from` is the creation block rather than just the floor.
  let located = Boolean(entry);
  if (!entry) {
    const created = await options.creationBlock?.().catch(() => null);
    located = created != null;
    const from = Math.max(options.floor, created ?? options.floor);
    entry = { version: 1, from, modifier: { syncedTo: from - 1, logs: [] }, posts: {} };
  }

  const unavailable = new Set<LogSource>();
  let rateLimited = false;
  const history = async (query: LogQuery): Promise<RawLog[]> => {
    let lastError: unknown = null;
    for (const source of [...explorers, rpc]) {
      if (unavailable.has(source)) continue;
      if (source === rpc && !located) {
        // An explorer reads from the floor in a call or two; bisecting for the
        // creation block is only worth its requests when the RPC walks the range.
        located = true;
        const created = await findCreationBlock(request, address, entry!.from, latest, signal);
        if (created !== null && created > entry!.from) entry!.from = created;
        query = { ...query, fromBlock: Math.max(query.fromBlock, entry!.from) };
        if (query.fromBlock > query.toBlock) return [];
      }
      try {
        return await source.getLogs(query, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof SourceUnavailable) {
          unavailable.add(source);
          rateLimited ||= /rate limited/i.test(error.message);
        }
        lastError = error;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (/archive|historical state|missing trie node|pruned/i.test(message)) throw new HistoryUnavailable(rateLimited, { cause: lastError });
    throw lastError ?? new Error("No log source is available.");
  };
  // The RPC is never behind the chain. Some public RPCs refuse eth_getLogs
  // outright (Base's answers every call with a rate limit); then an explorer is
  // better than nothing, though it may trail the head by a few blocks.
  const recent = async (query: LogQuery): Promise<RawLog[]> => {
    try {
      return await rpc.getLogs(query, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      for (const source of explorers) {
        if (unavailable.has(source)) continue;
        try {
          return await source.getLogs(query, signal);
        } catch {
          // Try the next explorer; the RPC's error is the one worth reporting.
        }
      }
      throw error;
    }
  };

  /**
   * One stream's logs between `start` and `end`: what is cached plus what is
   * new, each in as few requests as possible.
   *
   * - Never read before: one explorer-first request through `end`. An explorer
   *   answers a whole history in a call or two; a few of its newest blocks may
   *   lag, which the next read (RPC-first) makes up for.
   * - Read before, gap up to RECENT_BLOCKS: one RPC-first request through `end`.
   *   This is the case for a reload and for the check right before signing.
   * - Read long ago: explorer-first up to the cache head, RPC-first after it.
   *
   * Only blocks at or below `head` are cached; newer ones may still be reorged.
   */
  const refresh = async (stream: Stream, query: Omit<LogQuery, "fromBlock" | "toBlock">, start: number, end: number): Promise<RawLog[]> => {
    const fromBlock = Math.max(start, entry!.from, stream.syncedTo + 1);
    const fresh: RawLog[] = [];
    if (fromBlock <= end) {
      if (stream.syncedTo < entry!.from) {
        fresh.push(...(await history({ ...query, fromBlock, toBlock: end })));
      } else if (end - fromBlock + 1 <= RECENT_BLOCKS) {
        fresh.push(...(await recent({ ...query, fromBlock, toBlock: end })));
      } else {
        const cut = Math.min(end, head);
        fresh.push(...(await history({ ...query, fromBlock, toBlock: cut })));
        if (end > cut) fresh.push(...(await recent({ ...query, fromBlock: cut + 1, toBlock: end })));
      }
    }
    const settled = Math.min(end, head);
    if (settled > stream.syncedTo) {
      stream.logs.push(...fresh.filter((log) => log.blockNumber <= settled));
      stream.syncedTo = settled;
    }
    return [
      ...stream.logs.filter((log) => log.blockNumber >= start && log.blockNumber <= end),
      ...fresh.filter((log) => log.blockNumber > settled),
    ];
  };

  const modifierLogs = await refresh(entry.modifier, { address }, entry.from, latest);

  // Annotation posts count only while their sender owns the modifier, so each
  // owner's posts are read for their own periods of ownership: together one
  // pass over the history, whatever the number of owners. A finished period
  // is fully cached and never read again.
  const posts: RawLog[] = [];
  for (const period of ownershipPeriods(modifierLogs, latest)) {
    const query = { address: POSTER_ADDRESS.toLowerCase(), topics: [NEW_POST_TOPIC, zeroPadValue(period.owner, 32), ANNOTATION_TAG_TOPIC] };
    const stream = (entry.posts[period.owner] ??= { syncedTo: entry.from - 1, logs: [] });
    posts.push(...(await refresh(stream, query, period.start, period.end)));
  }

  try {
    await cache?.write(cacheKey, entry);
  } catch {
    // The cache only saves time; a browser without storage reads everything again.
  }
  const unique = new Map([...modifierLogs, ...posts].map((log) => [`${log.blockNumber}:${log.logIndex}`, log]));
  return [...unique.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/**
 * Who owned the modifier when, from RolesModSetup and OwnershipTransferred.
 * Both carry the owner they set as their second indexed topic. A period
 * includes the block it ends in: a post in the same block as a transfer is
 * judged by log order in the replay.
 */
export function ownershipPeriods(logs: readonly RawLog[], latest: number): { owner: string; start: number; end: number }[] {
  const ownerEvents = new Set([rolesEvents.getEvent("RolesModSetup")!.topicHash, rolesEvents.getEvent("OwnershipTransferred")!.topicHash]);
  const periods: { owner: string; start: number; end: number }[] = [];
  for (const log of [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)) {
    const topic = ownerEvents.has(log.topics[0] ?? "") ? log.topics[2] : undefined;
    if (!topic) continue;
    const owner = `0x${topic.slice(-40)}`;
    const current = periods.at(-1);
    if (current?.owner === owner) continue;
    if (current) current.end = log.blockNumber;
    if (BigInt(owner) !== 0n) periods.push({ owner, start: log.blockNumber, end: latest });
  }
  return periods;
}
