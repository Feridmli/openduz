/**
 * syncOpenseaOrders.js — OpenSea → Backend NFT order sync
 * Node.js ≥18 (fetch daxili gəlir)
 *
 * NOTE: Set OPENSEA_API_KEY either via environment variable or the hardcoded value below.
 */

const BACKEND_URL = process.env.BACKEND_URL || "https://openduz.onrender.com";
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || "0x54a88333F6e7540eA982261301309048aC431eD5";
const PROXY_CONTRACT_ADDRESS = process.env.PROXY_CONTRACT_ADDRESS || "0x9656448941C76B79A39BC4ad68f6fb9F01181EC7";
const PAGE_SIZE = 50;

// Put API key (user requested this specific key)
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || "e7f2a093b97e45a2bac1ed917a85420e";

const RETRY_LIMIT = 5;
const RETRY_DELAY = 5000;

const SENT_ORDER_HASHES = new Set();

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function safeFetch(url, options = {}, attempt = 1) {
  try {
    const res = await fetch(url, options);

    if (res.status === 429 || res.status === 403) {
      if (attempt <= RETRY_LIMIT) {
        console.log(`⛔ OpenSea ${res.status}. Retry #${attempt} in ${RETRY_DELAY/1000}s...`);
        await sleep(RETRY_DELAY);
        return safeFetch(url, options, attempt + 1);
      }
      console.log(`❌ ${res.status} after retries. Skipping.`);
      return null;
    }

    if (!res.ok) {
      console.log(`❌ Fetch error ${res.status}: ${res.statusText}`);
      return null;
    }

    return res;
  } catch (err) {
    if (attempt <= RETRY_LIMIT) {
      console.log(`⚠ Network error. Retry #${attempt}...`, err.message);
      await sleep(RETRY_DELAY);
      return safeFetch(url, options, attempt + 1);
    }
    console.log("❌ Network failed after retries.");
    return null;
  }
}

async function fetchOpenseaAssets(offset = 0) {
  const url = `https://api.opensea.io/api/v1/assets?asset_contract_address=${NFT_CONTRACT_ADDRESS}&order_direction=desc&offset=${offset}&limit=${PAGE_SIZE}`;

  const headers = {
    "Accept": "application/json",
    "X-API-KEY": OPENSEA_API_KEY
  };

  const res = await safeFetch(url, { headers });
  if (!res) return [];

  try {
    const data = await res.json();
    return data.assets || [];
  } catch {
    console.log("❌ JSON parse error");
    return [];
  }
}

async function postOrderToBackend(order) {
  const res = await safeFetch(`${BACKEND_URL}/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order)
  });

  if (!res) {
    console.log("❌ Backend call failed for token", order.tokenId);
    return;
  }

  try {
    const data = await res.json();
    if (!data.success) {
      console.log("⛔ Backend rejected:", data);
    } else {
      console.log(`✅ Saved token ${order.tokenId} (${order.price} ETH)`);
    }
  } catch {
    console.log("❌ Backend JSON error");
  }
}

// Convert large price strings safely using BigInt
function parsePriceFromOrder(order) {
  try {
    // OpenSea order.current_price is often string wei
    const cp = order.current_price ?? order.base_price ?? null;
    if (!cp) return 0;

    // cp may be string, possibly in decimal format; use BigInt via string
    const bn = BigInt(cp.toString());
    // convert to decimal ether string safely:
    // NOTE: we return as string with up to 18 decimals
    const denom = BigInt("1000000000000000000");
    const whole = bn / denom;
    const rem = bn % denom;
    const remStr = rem.toString().padStart(18, '0').replace(/0+$/, '');
    return remStr ? `${whole.toString()}.${remStr}` : `${whole.toString()}`;
  } catch (e) {
    return 0;
  }
}

async function main() {
  console.log("🚀 OpenSea Sync başladı...");
  let offset = 0;
  let totalNFT = 0;
  let totalOrders = 0;

  while (true) {
    console.log(`📦 Loading assets... offset=${offset}`);
    const assets = await fetchOpenseaAssets(offset);
    if (!assets || !assets.length) {
      console.log("⏹ No more assets or fetch failed.");
      break;
    }

    for (const nft of assets) {
      totalNFT++;

      if (!nft.sell_orders || !nft.sell_orders.length) continue;

      for (const order of nft.sell_orders) {
        if (!order.protocol_data?.parameters) continue;

        const hash = order.order_hash || `${nft.token_id}-${order.maker?.address || 'unknown'}`;
        if (SENT_ORDER_HASHES.has(hash)) continue;
        SENT_ORDER_HASHES.add(hash);

        const price = parsePriceFromOrder(order);
        const payload = {
          tokenId: nft.token_id,
          price: price.toString(),
          sellerAddress: (order.maker?.address || "unknown").toLowerCase(),
          seaportOrder: order.protocol_data,
          orderHash: hash,
          image: nft.image_url || nft.metadata?.image || null,
          marketplaceContract: PROXY_CONTRACT_ADDRESS
        };

        totalOrders++;
        await postOrderToBackend(payload);
      }
    }

    offset += PAGE_SIZE;
    await sleep(1000);
  }

  console.log("\n🎉 SYNC TAMAMLANDI");
  console.log("📌 Total NFT scanned:", totalNFT);
  console.log("📌 Total orders sent:", totalOrders);
}

main().catch(err => {
  console.error("💀 FATAL ERROR:", err);
  process.exit(1);
});
