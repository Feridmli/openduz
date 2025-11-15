/* main.js -- module */
import { ethers } from "ethers";
import { Seaport } from "@opensea/seaport-js";

/*
  Xahiş: deploy etdikdən sonra BACKEND_URL-u öz Render URL-inlə əvəz et.
*/
const BACKEND_URL = "https://sənin-app.onrender.com"; // <- burada öz URL qoy
const PROXY_CONTRACT_ADDRESS = "0x9656448941C76B79A39BC4ad68f6fb9F01181EC7";
const NFT_CONTRACT_ADDRESS = "0x54a88333F6e7540eA982261301309048aC431eD5";
const APECHAIN_ID = 33139; // əgər fərqli chain-dirsə uyğunlaşdır

let provider = null;
let signer = null;
let seaport = null;
let userAddress = null;

let currentPage = 1;
const PAGE_SIZE = 12;

const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const addrSpan = document.getElementById("addr");
const marketplaceDiv = document.getElementById("marketplace");
const noticeDiv = document.getElementById("notice");
const pageIndicator = document.getElementById("pageIndicator");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");

function notify(msg, timeout = 4000) {
  noticeDiv.textContent = msg;
  if (timeout > 0) setTimeout(() => { if (noticeDiv.textContent === msg) noticeDiv.textContent = ""; }, timeout);
}

/* --- Wallet connect --- */
async function connectWallet() {
  try {
    if (!window.ethereum) return alert("Metamask/Vişual Ethereum provider tapılmadı!");

    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    // request accounts
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    userAddress = (await signer.getAddress()).toLowerCase();

    // Şəbəkə yoxlaması: əgər chainId uyğun gəlmirsə, cüzdana şəbəkəni əlavə etməyə çağıra bilərik
    const network = await provider.getNetwork();
    if (network.chainId !== APECHAIN_ID) {
      try {
        await provider.send("wallet_addEthereumChain", [{
          chainId: "0x" + APECHAIN_ID.toString(16),
          chainName: "ApeChain Mainnet",
          nativeCurrency: { name: "APE", symbol: "APE", decimals: 18 },
          rpcUrls: ["https://rpc.apechain.com"],
          blockExplorerUrls: ["https://apescan.io"]
        }]);
        notify("Şəbəkə dəyişdirildi. Yenidən qoşun.");
      } catch (e) {
        console.warn("Şəbəkə əlavə etmə uğursuz oldu:", e);
      }
    }

    // Seaport init (müştərinin seaport proxy ünvanını buraya veririk)
    // Keep contractAddress provided (user asked not to change wallet connect area)
    seaport = new Seaport(signer, { contractAddress: PROXY_CONTRACT_ADDRESS });

    connectBtn.style.display = "none";
    disconnectBtn.style.display = "inline-block";
    addrSpan.textContent = userAddress.slice(0,6) + "..." + userAddress.slice(-4);

    // ilk səhifəni yüklə
    await loadOrders(currentPage);
  } catch (err) {
    console.error("Wallet connect error:", err);
    alert("Cüzdan qoşularkən xəta oldu. Konsolu yoxla.");
  }
}

connectBtn.onclick = connectWallet;
disconnectBtn.onclick = () => {
  provider = signer = seaport = userAddress = null;
  connectBtn.style.display = "inline-block";
  disconnectBtn.style.display = "none";
  addrSpan.textContent = "";
  marketplaceDiv.innerHTML = "";
  notify("Cüzdan ayırıldı", 2000);
};

/* --- Pagination --- */
prevBtn.onclick = () => {
  if (currentPage > 1) {
    currentPage--;
    loadOrders(currentPage);
  }
};
nextBtn.onclick = () => {
  currentPage++;
  loadOrders(currentPage);
};

/* --- Load orders (backend ilə pagination) --- */
async function loadOrders(page = 1) {
  try {
    pageIndicator.textContent = page;
    marketplaceDiv.innerHTML = "<p style='opacity:.7'>Yüklənir...</p>";

    const res = await fetch(`${BACKEND_URL}/orders?page=${page}&limit=${PAGE_SIZE}`);
    if (!res.ok) {
      console.error("Server response", res.status, await res.text());
      marketplaceDiv.innerHTML = "<p>Xəta: serverdən məlumat gəlmədi.</p>";
      return;
    }
    const data = await res.json();

    if (!data.success) {
      marketplaceDiv.innerHTML = "<p>Xəta: serverdən məlumat gəlmədi.</p>";
      console.error(data);
      return;
    }

    const orders = data.orders || [];
    if (!orders.length) {
      marketplaceDiv.innerHTML = "<p>Bu səhifədə satışda NFT yoxdur.</p>";
      return;
    }

    marketplaceDiv.innerHTML = "";
    for (const o of orders) {
      // backend-də tokenId böyük/kiçik hərf fərqi ola bilər -> normalize et
      const tokenId = o.tokenId ?? o.tokenid ?? o.token_id ?? (o.token ? o.token : "unknown");
      const price = o.price ?? o.list_price ?? parseOrderPrice(o);
      const image = o.image ?? (o.metadata && o.metadata.image) ?? o.image_url ?? null;

      const card = document.createElement("div");
      card.className = "nft-card";
      card.innerHTML = `
        <img src="${image || 'https://ipfs.io/ipfs/QmExampleNFTImage/1.png'}" alt="NFT image" onerror="this.src='https://ipfs.io/ipfs/QmExampleNFTImage/1.png'">
        <h4>Bear #${tokenId}</h4>
        <p class="price">Qiymət: ${price ?? 'Not listed' } APE</p>
        <div class="nft-actions">
          <button class="wallet-btn" data-token="${tokenId}" data-orderid="${o.id || o.order_id || ''}">Buy</button>
        </div>
      `;
      marketplaceDiv.appendChild(card);

      // buy düyməsinin click handler-i
      const buyBtn = card.querySelector("button");
      buyBtn.onclick = async (ev) => {
        ev.target.disabled = true;
        try {
          await buyNFT(o); // tam order obyekti ötürürük
        } catch (e) {
          console.error("buy handler error:", e);
        } finally {
          ev.target.disabled = false;
        }
      };
    }
  } catch (err) {
    console.error("loadOrders error:", err);
    marketplaceDiv.innerHTML = "<p>Xəta baş verdi (konsolu yoxla).</p>";
  }
}

/* köməkçi: bəzən backend-də price struktur fərqli olur -- burda sadə parse */
function parseOrderPrice(o) {
  try {
    // əgər seaportOrder içində parameters.consideration varsa, parse et
    const so = o.seaportOrder || o.seaportorder || o.seaport_order || (o.seaportOrderJSON ? JSON.parse(o.seaportOrderJSON) : null);
    const params = (so && so.parameters) ? so.parameters : (so && so.consideration ? so : null);
    if (params && params.consideration) {
      const cons = params.consideration;
      if (cons.length > 0) {
        const amount = cons[0].endAmount ?? cons[0].startAmount ?? cons[0].amount ?? null;
        if (amount) {
          // endAmount bəzən string wei və ya { "value": "..." } şəklində ola bilər
          let amt = amount;
          if (typeof amount === "object" && (amount.toString || amount.value)) {
            amt = amount.toString ? amount.toString() : amount.value;
          }
          const bn = ethers.BigNumber.from(amt.toString());
          return ethers.utils.formatEther(bn);
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/* --- buyNFT: real on-chain fulfill --- */
async function buyNFT(orderRecord) {
  if (!seaport || !signer) return alert("Əvvəlcə cüzdanı qoşun!");

  notify("Transaksiya hazırlanır...");

  // orderRecord içində seaport orderin tam JSON-ını gözləyirik:
  const order = orderRecord.seaportOrder || orderRecord.seaportorder || orderRecord.seaport_order;
  let parsedOrder = order;

  if (!order && orderRecord.seaportOrderJSON) {
    try { parsedOrder = JSON.parse(orderRecord.seaportOrderJSON); } catch (e) { parsedOrder = null; }
  }

  if (!parsedOrder) {
    alert("Order məlumatı tapılmadı. Backend-də seaport order JSON-u lazımdır.");
    return;
  }

  try {
    const buyerAddr = await signer.getAddress();

    // Seaport.fulfillOrder müxtəlif versiyalarda fərqli qaydada işləyə bilər.
    // Burada bir neçə fallback ilə çalışırıq:
    notify("Seaport-ə əməliyyat göndərilir...");

    // Try various shapes:
    // 1) seaport.fulfillOrder({ order, accountAddress }) -> returns { executeAllActions }
    // 2) seaport.fulfillOrder(order, accountAddress) -> returns { actions }
    // 3) seaport.fulfillOrder(order) -> returns tx-like (older)
    let result;
    try {
      result = await seaport.fulfillOrder({ order: parsedOrder, accountAddress: buyerAddr });
    } catch (e) {
      // try alternate signature
      try {
        result = await seaport.fulfillOrder(parsedOrder, buyerAddr);
      } catch (e2) {
        // older versions might throw, try direct fulfill (will likely fail)
        result = e2 || e;
      }
    }

    // extract execute function(s)
    const execute =
      (result && result.executeAllActions) ? result.executeAllActions :
      (result && result.actions && typeof result.actions.executeAll === "function") ? result.actions.executeAll.bind(result.actions) :
      (result && result.execute) ? result.execute :
      null;

    if (!execute) {
      // maybe result itself is a tx response / promise with wait
      if (result && typeof result.wait === "function") {
        notify("Transaksiya göndərildi, gözlənilir...");
        await result.wait();
        notify("Alış tamamlandı!");
        await loadOrders(currentPage);
        return;
      }
      console.error("Seaport result strukturunda execute tapılmadı:", result);
      throw new Error("Seaport SDK execute funksiyası tapılmadı");
    }

    // execute may be a function that returns a txResponse or a Promise
    const execRes = await execute();
    let txResponse = execRes;

    // If execute returned object with executeAllActions again, try to handle
    if (execRes && execRes.executeAllActions) {
      txResponse = await execRes.executeAllActions();
    }

    notify("Transaksiya blockchain-ə göndərildi. Gözlənilir...");
    if (txResponse && typeof txResponse.wait === "function") {
      await txResponse.wait();
    } else {
      // nothing to wait for, proceed
      console.warn("txResponse.wait tapılmadı, confirm yoxlanılmadı.");
    }

    notify("NFT uğurla alındı ✅");
    await loadOrders(currentPage);
  } catch (err) {
    console.error("buyNFT error:", err);
    alert("Alış zamanı xəta: " + (err && err.message ? err.message : String(err)));
  }
}

/* EXPORT (bəzən səhvən window access lazım olur) */
window.buyNFT = buyNFT;
window.loadOrders = loadOrders;