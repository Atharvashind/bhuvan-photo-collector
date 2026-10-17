const captureButton = document.querySelector("#capture");
const scanButton = document.querySelector("#scan-block");
const analyzeBoardsButton = document.querySelector("#analyze-boards");
const downloadButton = document.querySelector("#download");
const downloadBoardsButton = document.querySelector("#download-boards");
const clearButton = document.querySelector("#clear");
const clearBoardsButton = document.querySelector("#clear-boards");
const notice = document.querySelector("#notice");
const count = document.querySelector("#count");
const items = document.querySelector("#items");
const boardCount = document.querySelector("#board-count");
const boardItems = document.querySelector("#board-items");
const scanProgress = document.querySelector("#scan-progress");
const boardProgress = document.querySelector("#board-progress");

let savedPhotos = [];
let savedBoardPhotos = [];
let analyzedPhotoKeys = new Set();

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
}

function render() {
  count.textContent = String(savedPhotos.length);
  downloadButton.disabled = savedPhotos.length === 0;
  clearButton.disabled = savedPhotos.length === 0;
  analyzeBoardsButton.disabled = savedPhotos.every((photo) => analyzedPhotoKeys.has(photo.key));
  boardCount.textContent = String(savedBoardPhotos.length);
  downloadBoardsButton.disabled = savedBoardPhotos.length === 0;
  clearBoardsButton.disabled = savedBoardPhotos.length === 0;
  items.replaceChildren();
  renderBoardPhotos();

  if (!savedPhotos.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No photos collected yet.";
    items.append(empty);
    return;
  }

  for (const photo of savedPhotos.slice(-12).reverse()) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = [photo.state, photo.district, photo.assetId || "Asset"].join(" / ");

    const detail = document.createElement("div");
    detail.className = "item-detail";
    detail.textContent = `${photo.stageHint} · ${photo.filename}`;

    item.append(title, detail);
    items.append(item);
  }

}

function renderBoardPhotos() {
  boardItems.replaceChildren();

  if (!savedBoardPhotos.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No board photos identified yet.";
    boardItems.append(empty);
    return;
  }

  for (const photo of savedBoardPhotos.slice(-8).reverse()) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = [photo.state, photo.district, photo.assetId || "Asset"].join(" / ");

    const detail = document.createElement("div");
    detail.className = "item-detail";
    detail.textContent = `OCR ${photo.boardConfidence}% · ${photo.boardText || photo.filename}`;

    item.append(title, detail);
    boardItems.append(item);
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function captureFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "CAPTURE_VISIBLE_PHOTOS" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return chrome.tabs.sendMessage(tabId, { type: "CAPTURE_VISIBLE_PHOTOS" });
  }
}

async function executeInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args
  });
  return results[0]?.result;
}

async function getBlockSnapshot() {
  const readSelect = (id) => {
    const select = document.querySelector(`#${id}`);
    return {
      value: select?.value || "",
      label: select?.selectedOptions[0]?.textContent?.trim() || "Unknown"
    };
  };
  const state = readSelect("statecode");
  const district = readSelect("district");
  const block = readSelect("block");
  const stage = readSelect("stage");

  if (!state.value || state.value === "all" || !district.value || district.value === "all" || !block.value || block.value === "all") {
    return { error: "Select a state, district, and one block first." };
  }

  if (!window.map || !window.wmslayer || !wmslayer.getVisibility() || !wmslayer.div) {
    return { error: "On Bhuvan, click View to load the filtered block points first." };
  }

  const filter = String(wmslayer.params?.CQL_FILTER || "");
  if (!filter.includes(`block_code='${block.value}'`)) {
    return { error: "The map does not match the selected block. Click View after changing the filters." };
  }

  const mode = window.mode || (document.querySelector("#mod")?.textContent.trim() === "Disable Moderation" ? "m" : "nm");
  const query = new URLSearchParams({
    state: state.value,
    fyear: document.querySelector("#fyear")?.value || "all",
    district: district.value,
    block: block.value,
    stage: stage.value,
    panchayat: document.querySelector("#gp")?.value || "all",
    category_id: document.querySelector("#cat")?.value || "all",
    sub_category_id: document.querySelector("#sub")?.value || "all",
    mode
  });
  const boundaryResponse = await fetch(`usrtasks/nrega_phase2/get/bound.php?${query}`, { credentials: "same-origin" });
  const boundaryText = (await boundaryResponse.text()).trim();
  const boundsMatch = boundaryText.match(/BOX\(([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+)\)/i);
  if (!boundaryResponse.ok || !boundsMatch) {
    return { error: "Bhuvan did not return a boundary for this block." };
  }

  const bounds = boundsMatch.slice(1).map(Number);
  map.zoomToExtent(new OpenLayers.Bounds(bounds[0], bounds[1], bounds[2], bounds[3]));
  const viewport = map.viewPortDiv.getBoundingClientRect();
  let visibleImages = [];
  let previousSignature = "";
  let stablePolls = 0;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    visibleImages = [...wmslayer.div.querySelectorAll("img.olTileImage")].filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.right > viewport.left && rect.left < viewport.right && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const signature = visibleImages.map((image) => image.currentSrc || image.src).join("|");
    const loaded = visibleImages.length > 0 && visibleImages.every((image) => image.complete && image.naturalWidth > 0);
    stablePolls = loaded && signature === previousSignature ? stablePolls + 1 : 0;
    previousSignature = signature;
    if (stablePolls >= 2) break;
  }

  if (!visibleImages.length || visibleImages.some((image) => !image.complete || image.naturalWidth === 0)) {
    return { error: "The block map tiles did not finish loading. Wait for the map, then try again." };
  }

  const tiles = visibleImages.map((image) => {
    const rect = image.getBoundingClientRect();
    return {
      url: image.currentSrc || image.src,
      left: rect.left - viewport.left,
      top: rect.top - viewport.top,
      width: rect.width,
      height: rect.height
    };
  });

  return {
    state: state.label,
    district: district.label,
    block: block.label,
    blockCode: block.value,
    stage: stage.value,
    mode,
    tiles
  };
}

async function identifyAndCollect(candidates, knownAssetIds = []) {
  const control = window.houseinfo;
  if (!control || !window.OpenLayers || !window.wmslayer) return { error: "Bhuvan's active identify control was not found." };

  const listeners = control.events.listeners;
  const originalInfoListeners = listeners.getfeatureinfo;
  const originalBeforeListeners = listeners.beforegetfeatureinfo;
  const originalMaxFeatures = control.maxFeatures;
  const state = document.querySelector("#statecode")?.selectedOptions[0]?.textContent.trim() || "Unknown";
  const district = document.querySelector("#district")?.selectedOptions[0]?.textContent.trim() || "Unknown";
  const block = document.querySelector("#block")?.selectedOptions[0]?.textContent.trim() || "Unknown";
  const blockCode = document.querySelector("#block")?.value || "";
  const stage = document.querySelector("#stage")?.value || "all";
  const mode = window.mode || (document.querySelector("#mod")?.textContent.trim() === "Disable Moderation" ? "m" : "nm");
  const username = mode === "nm" ? "empty" : (window.bhuvanusername || "empty");
  const seenSerials = new Set(knownAssetIds.map(String));
  const batchSerials = new Set();
  const photos = [];
  let queryErrors = 0;
  let detailErrors = 0;

  function safe(value) {
    return String(value || "unknown").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 45) || "unknown";
  }

  function extension(url) {
    return new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|bmp)$/i)?.[1]?.toLowerCase().replace("jpeg", "jpg") || "jpg";
  }

  async function getAssetPhotos(serial) {
    const url = new URL("usrtasks/nrega_phase2/get/get_details.php", location.href);
    url.search = new URLSearchParams({
      sno: String(serial),
      uname: username,
      mode,
      key: String(Math.random()),
      stage,
      block_code: blockCode
    });
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Details request failed: ${response.status}`);

    const html = await response.text();
    const details = new DOMParser().parseFromString(html, "text/html");
    const detailText = (details.body.innerText || details.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1200);
    const imageLinks = [...details.querySelectorAll('a[onclick*="changeImage"]')]
      .map((anchor) => {
        const match = anchor.getAttribute("onclick")?.match(/changeImage\(["']([^"']+)["']\)/i);
        if (!match) return null;
        const url = new URL(match[1], location.href).href.replace("/photos_comp2/", "/photos/");
        const cellText = (anchor.closest("td")?.innerText || "").replace(/\s+/g, " ").trim();
        return { url, stageHint: `${cellText} photo ${anchor.textContent.trim()}`.trim() };
      })
      .filter((photo) => photo && /^https?:/i.test(photo.url));

    if (!imageLinks.length) {
      const image = details.querySelector("#attachphoto");
      if (image?.src) imageLinks.push({ url: image.src.replace("/photos_comp2/", "/photos/"), stageHint: "photo" });
    }

    imageLinks.forEach((image, index) => {
      const fileExt = extension(image.url);
      const filename = [safe(state), safe(district), safe(block), safe(serial), safe(image.stageHint), index + 1].join("-");
      photos.push({
        key: `${image.url}|${state}|${district}|${serial}`,
        url: image.url,
        state,
        district,
        assetId: String(serial),
        stageHint: image.stageHint,
        details: detailText,
        filename: `${filename}.${fileExt}`,
        capturedAt: new Date().toISOString()
      });
    });
  }

  async function queryCandidate(candidate) {
    return new Promise((resolve) => {
      let completed = false;
      const finish = (text, timedOut = false) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        control.events.unregister("getfeatureinfo", control, onInfo);
        resolve({ text, timedOut });
      };
      const onInfo = (event) => finish(event.text, false);
      const timeout = setTimeout(() => finish("", true), 7000);
      control.events.register("getfeatureinfo", control, onInfo);
      try {
        control.getInfoForClick({ xy: new OpenLayers.Pixel(candidate.x, candidate.y) });
      } catch {
        finish("", true);
      }
    });
  }

  listeners.getfeatureinfo = [];
  listeners.beforegetfeatureinfo = [];
  control.maxFeatures = 50;

  try {
    for (const candidate of candidates) {
      const response = await queryCandidate(candidate);
      const text = response.text;
      if (response.timedOut) queryErrors += 1;
      let records;
      try {
        records = JSON.parse(String(text || ""));
      } catch {
        records = [];
      }

      const serials = Array.isArray(records)
        ? records.map((record) => record?.collection_sno).filter((serial) => serial !== undefined && serial !== null && String(serial) !== "")
        : [];

      for (const serial of serials) {
        const key = String(serial);
        if (seenSerials.has(key)) continue;
        seenSerials.add(key);
        batchSerials.add(key);
        try {
          await getAssetPhotos(key);
        } catch {
          detailErrors += 1;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    listeners.getfeatureinfo = originalInfoListeners;
    listeners.beforegetfeatureinfo = originalBeforeListeners;
    control.maxFeatures = originalMaxFeatures;
  }

  return { photos, assets: batchSerials.size, assetIds: [...batchSerials], queryErrors, detailErrors };
}

async function loadPhotos() {
  const [photoResult, boardResult] = await Promise.all([
    sendMessage({ type: "GET_PHOTOS" }),
    sendMessage({ type: "GET_BOARD_DATA" })
  ]);
  savedPhotos = photoResult?.photos || [];
  savedBoardPhotos = boardResult?.boardPhotos || [];
  analyzedPhotoKeys = new Set(boardResult?.analyzedKeys || []);
  render();
}

function makeOCRWorker() {
  if (typeof Tesseract === "undefined") throw new Error("The bundled OCR engine did not load. Reload the extension.");

  return Tesseract.createWorker("mar+eng", 1, {
    workerPath: chrome.runtime.getURL("vendor/worker.min.js"),
    corePath: chrome.runtime.getURL("vendor/core/tesseract-core-lstm.wasm.js"),
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    gzip: true,
    workerBlobURL: false,
    logger: (message) => {
      if (message.status === "loading language traineddata") {
        showNotice(`Loading Marathi/English OCR data: ${Math.round((message.progress || 0) * 100)}%`);
      }
    }
  });
}

async function getOCRImage(photo) {
  const compressedUrl = photo.url.replace("/photos/", "/photos_comp2/");
  let response = await fetch(compressedUrl, { cache: "force-cache" });
  if (!response.ok && compressedUrl !== photo.url) {
    response = await fetch(photo.url, { cache: "force-cache" });
  }
  if (!response.ok) throw new Error(`Photo request failed (${response.status})`);

  const bitmap = await createImageBitmap(await response.blob());
  const maxDimension = 2000;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

function looksLikeBoard(text, confidence) {
  const normalized = text.replace(/[^\p{L}\p{N}\n]+/gu, " ").trim();
  const letters = [...normalized.matchAll(/\p{L}/gu)].length;
  const devanagari = [...normalized.matchAll(/\p{Script=Devanagari}/gu)].length;
  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter((line) => [...line].length >= 4);

  return confidence >= 18 && (
    (devanagari >= 8 && letters >= 12) ||
    (letters >= 28 && lines.length >= 2)
  );
}

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  showNotice("Checking the open Bhuvan asset panel...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://bhuvan-app2.nrsc.gov.in/bhugram/")) {
      throw new Error("Open the Bhuvan-BHUGRAM page first.");
    }

    const result = await captureFromTab(tab.id);
    if (result?.error) throw new Error(result.error);

    const saved = await sendMessage({ type: "ADD_PHOTOS", photos: result.photos });
    await loadPhotos();
    showNotice(saved.added ? `Captured ${saved.added} photo.` : "That photo is already collected.");
  } catch (error) {
    showNotice(error.message || "Could not capture the open photo.", true);
  } finally {
    captureButton.disabled = false;
  }
});

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  captureButton.disabled = true;
  scanProgress.hidden = false;
  scanProgress.max = 1;
  scanProgress.value = 0;
  showNotice("Preparing the selected block. Keep this popup open during collection.");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://bhuvan-app2.nrsc.gov.in/bhugram/")) {
      throw new Error("Open Bhuvan-BHUGRAM first.");
    }

    const snapshot = await executeInPage(tab.id, getBlockSnapshot);
    if (snapshot?.error) throw new Error(snapshot.error);

    showNotice(`Detecting markers in ${snapshot.block}, ${snapshot.district}...`);
    const detection = await sendMessage({ type: "DETECT_MARKERS", tiles: snapshot.tiles });
    if (detection.failedTiles) {
      const firstError = detection.errors?.[0];
      const reason = firstError ? `${firstError.message} (${new URL(firstError.url).hostname})` : "Unknown tile error";
      throw new Error(`Could not inspect ${detection.failedTiles} of ${detection.tileCount} map tiles: ${reason}.`);
    }
    if (!detection.markers.length) throw new Error("No green asset markers were found in the selected block view.");
    if (detection.markers.length > 1200 && !window.confirm(`Found ${detection.markers.length} marker locations. Collection may take a long time. Continue?`)) {
      showNotice("Block collection cancelled.");
      return;
    }

    scanProgress.max = detection.markers.length;
    let assets = 0;
    let added = 0;
    let queryErrors = 0;
    let detailErrors = 0;
    const seenAssetIds = new Set();
    const batchSize = 16;

    for (let offset = 0; offset < detection.markers.length; offset += batchSize) {
      const batch = detection.markers.slice(offset, offset + batchSize);
      const result = await executeInPage(tab.id, identifyAndCollect, [batch, [...seenAssetIds]]);
      if (result?.error) throw new Error(result.error);
      const saved = await sendMessage({ type: "ADD_PHOTOS", photos: result.photos || [] });
      for (const assetId of result.assetIds || []) seenAssetIds.add(String(assetId));
      assets = seenAssetIds.size;
      added += saved.added || 0;
      queryErrors += result.queryErrors || 0;
      detailErrors += result.detailErrors || 0;
      scanProgress.value = Math.min(offset + batch.length, detection.markers.length);
      showNotice(`Scanned ${scanProgress.value}/${detection.markers.length} marker locations · ${assets} assets · ${added} photos saved`);
    }

    await loadPhotos();
    showNotice(`Block scan finished: ${assets} assets, ${added} new photos. Identify errors: ${queryErrors}; detail errors: ${detailErrors}.`);
  } catch (error) {
    showNotice(error.message || "Block collection failed.", true);
  } finally {
    scanButton.disabled = false;
    captureButton.disabled = false;
    scanProgress.hidden = true;
  }
});

analyzeBoardsButton.addEventListener("click", async () => {
  const pendingPhotos = savedPhotos.filter((photo) => !analyzedPhotoKeys.has(photo.key));
  if (!pendingPhotos.length) {
    showNotice("All collected photos have already been checked.");
    return;
  }

  analyzeBoardsButton.disabled = true;
  scanButton.disabled = true;
  captureButton.disabled = true;
  boardProgress.hidden = false;
  boardProgress.max = pendingPhotos.length;
  boardProgress.value = 0;
  let worker;
  let matches = 0;
  let failures = 0;
  const newMatches = [];
  const newlyAnalyzed = [];

  try {
    showNotice(`Starting local Marathi/English OCR for ${pendingPhotos.length} photos...`);
    worker = await makeOCRWorker();

    for (const [index, photo] of pendingPhotos.entries()) {
      try {
        const image = await getOCRImage(photo);
        const { data } = await worker.recognize(image);
        if (looksLikeBoard(data.text || "", data.confidence || 0)) {
          newMatches.push({
            ...photo,
            boardText: (data.text || "").replace(/\s+/g, " ").trim().slice(0, 500),
            boardConfidence: Math.round(data.confidence || 0)
          });
          matches += 1;
        }
        newlyAnalyzed.push(photo.key);
      } catch {
        failures += 1;
      }

      boardProgress.value = index + 1;
      showNotice(`Checking boards ${index + 1}/${pendingPhotos.length} · ${matches} likely boards found`);

      if (newlyAnalyzed.length >= 5 || index === pendingPhotos.length - 1) {
        await sendMessage({
          type: "SAVE_BOARD_RESULTS",
          boardPhotos: newMatches.splice(0),
          analyzedKeys: newlyAnalyzed.splice(0)
        });
        await loadPhotos();
      }
    }

    showNotice(`Board check finished: ${matches} likely boards found; ${failures} images could not be checked.`);
  } catch (error) {
    showNotice(error.message || "Could not start local OCR.", true);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    analyzeBoardsButton.disabled = savedPhotos.every((photo) => analyzedPhotoKeys.has(photo.key));
    scanButton.disabled = false;
    captureButton.disabled = false;
    boardProgress.hidden = true;
  }
});

downloadButton.addEventListener("click", async () => {
  downloadButton.disabled = true;
  showNotice(`Starting ${savedPhotos.length} download${savedPhotos.length === 1 ? "" : "s"}...`);

  try {
    const result = await sendMessage({ type: "DOWNLOAD_PHOTOS", photos: savedPhotos });
    showNotice(`Started ${result.downloaded} downloads; failed to start ${result.failed}.`);
  } catch (error) {
    showNotice(error.message || "Download could not start.", true);
  } finally {
    downloadButton.disabled = savedPhotos.length === 0;
  }
});

clearButton.addEventListener("click", async () => {
  const result = await sendMessage({ type: "CLEAR_PHOTOS" });
  if (result?.ok) {
    savedPhotos = [];
    render();
    showNotice("Collected list cleared.");
  }
});

downloadBoardsButton.addEventListener("click", async () => {
  downloadBoardsButton.disabled = true;
  showNotice(`Starting ${savedBoardPhotos.length} board-photo download${savedBoardPhotos.length === 1 ? "" : "s"}...`);

  try {
    const result = await sendMessage({ type: "DOWNLOAD_BOARD_PHOTOS", photos: savedBoardPhotos });
    showNotice(`Started ${result.downloaded} board-photo downloads; failed to start ${result.failed}.`);
  } catch (error) {
    showNotice(error.message || "Board-photo download could not start.", true);
  } finally {
    downloadBoardsButton.disabled = savedBoardPhotos.length === 0;
  }
});

clearBoardsButton.addEventListener("click", async () => {
  const result = await sendMessage({ type: "CLEAR_BOARD_PHOTOS" });
  if (result?.ok) {
    await loadPhotos();
    showNotice("Board results cleared. Collected photos were kept.");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "DOWNLOAD_PROGRESS") {
    showNotice(`Downloading ${message.completed} of ${message.total}...`);
  }
});

loadPhotos().catch(() => showNotice("Could not load the collection list.", true));