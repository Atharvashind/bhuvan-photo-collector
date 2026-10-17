const STORAGE_KEY = "capturedPhotos";
const BOARD_STORAGE_KEY = "boardPhotos";
const ANALYZED_STORAGE_KEY = "analyzedPhotoKeys";

async function readPhotos() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_PHOTOS") {
    readPhotos().then((photos) => sendResponse({ photos }));
    return true;
  }

  if (message?.type === "GET_BOARD_DATA") {
    chrome.storage.local.get([BOARD_STORAGE_KEY, ANALYZED_STORAGE_KEY]).then((result) => {
      sendResponse({
        boardPhotos: result[BOARD_STORAGE_KEY] || [],
        analyzedKeys: result[ANALYZED_STORAGE_KEY] || []
      });
    });
    return true;
  }

  if (message?.type === "ADD_PHOTOS") {
    readPhotos().then(async (photos) => {
      const keys = new Set(photos.map((photo) => photo.key));
      const additions = (message.photos || []).filter((photo) => !keys.has(photo.key));
      const updated = [...photos, ...additions];
      await chrome.storage.local.set({ [STORAGE_KEY]: updated });
      sendResponse({ added: additions.length, total: updated.length });
    });
    return true;
  }

  if (message?.type === "CLEAR_PHOTOS") {
    chrome.storage.local.set({
      [STORAGE_KEY]: [],
      [BOARD_STORAGE_KEY]: [],
      [ANALYZED_STORAGE_KEY]: []
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "SAVE_BOARD_RESULTS") {
    chrome.storage.local.get([BOARD_STORAGE_KEY, ANALYZED_STORAGE_KEY]).then(async (result) => {
      const existing = result[BOARD_STORAGE_KEY] || [];
      const boardKeys = new Set(existing.map((photo) => photo.key));
      const additions = (message.boardPhotos || []).filter((photo) => !boardKeys.has(photo.key));
      const analyzedKeys = new Set(result[ANALYZED_STORAGE_KEY] || []);
      for (const key of message.analyzedKeys || []) analyzedKeys.add(key);
      const boardPhotos = [...existing, ...additions];
      await chrome.storage.local.set({
        [BOARD_STORAGE_KEY]: boardPhotos,
        [ANALYZED_STORAGE_KEY]: [...analyzedKeys]
      });
      sendResponse({ added: additions.length, total: boardPhotos.length, analyzed: analyzedKeys.size });
    });
    return true;
  }

  if (message?.type === "CLEAR_BOARD_PHOTOS") {
    chrome.storage.local.set({ [BOARD_STORAGE_KEY]: [], [ANALYZED_STORAGE_KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "DOWNLOAD_PHOTOS") {
    downloadPhotos(message.photos || [], "").then(sendResponse);
    return true;
  }

  if (message?.type === "DOWNLOAD_BOARD_PHOTOS") {
    downloadPhotos(message.photos || [], "BoardPhotos").then(sendResponse);
    return true;
  }

  if (message?.type === "DETECT_MARKERS") {
    detectMarkers(message.tiles || []).then(sendResponse);
    return true;
  }
});

async function detectMarkers(tiles) {
  const markers = [];
  const seen = new Set();
  const errors = [];
  let failedTiles = 0;

  for (const tile of tiles) {
    try {
      const response = await fetch(tile.url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`Tile request failed: ${response.status}`);

      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const pixelCount = bitmap.width * bitmap.height;
      const mask = new Uint8Array(pixelCount);

      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        if (pixels[offset + 3] > 180 && green >= 100 && red < 100 && blue < 60 && green > red * 1.4) {
          mask[index] = 1;
        }
      }

      const queue = new Int32Array(pixelCount);
      const scaleX = tile.width / bitmap.width;
      const scaleY = tile.height / bitmap.height;

      for (let start = 0; start < pixelCount; start += 1) {
        if (!mask[start]) continue;

        mask[start] = 0;
        queue[0] = start;
        let head = 0;
        let tail = 1;
        let sumX = 0;
        let sumY = 0;
        const component = [];

        while (head < tail) {
          const index = queue[head++];
          const x = index % bitmap.width;
          const y = Math.floor(index / bitmap.width);
          component.push(index);
          sumX += x;
          sumY += y;

          for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(bitmap.height - 1, y + 1); neighborY += 1) {
            for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(bitmap.width - 1, x + 1); neighborX += 1) {
              const neighbor = neighborY * bitmap.width + neighborX;
              if (mask[neighbor]) {
                mask[neighbor] = 0;
                queue[tail++] = neighbor;
              }
            }
          }
        }

        if (component.length < 2 || component.length > 500) continue;

        const points = [{ x: sumX / component.length, y: sumY / component.length }];
        if (component.length > 60) {
          const bins = new Map();
          for (const index of component) {
            const x = index % bitmap.width;
            const y = Math.floor(index / bitmap.width);
            const key = `${Math.floor(x / 5)}:${Math.floor(y / 5)}`;
            const bin = bins.get(key) || { count: 0, x: 0, y: 0 };
            bin.count += 1;
            bin.x += x;
            bin.y += y;
            bins.set(key, bin);
          }
          for (const bin of bins.values()) {
            if (bin.count >= 3) points.push({ x: bin.x / bin.count, y: bin.y / bin.count });
          }
        }

        for (const point of points) {
          const x = Math.round(tile.left + point.x * scaleX);
          const y = Math.round(tile.top + point.y * scaleY);
          const key = `${Math.round(x / 3)}:${Math.round(y / 3)}`;
          if (!seen.has(key)) {
            seen.add(key);
            markers.push({ x, y });
          }
        }
      }

      bitmap.close();
    } catch (error) {
      failedTiles += 1;
      if (errors.length < 3) errors.push({ url: tile.url, message: error.message || String(error) });
    }
  }

  return { markers, failedTiles, tileCount: tiles.length, errors };
}

async function downloadPhotos(photos, subfolder) {
  let downloaded = 0;
  let failed = 0;

  for (const photo of photos) {
    const folder = [photo.state, photo.district]
      .map((part) => String(part || "Unknown").replace(/[\\/:*?"<>|]/g, "-").trim())
      .join("/");

    try {
      await chrome.downloads.download({
        url: photo.url,
        filename: `Bhuvan/${subfolder ? `${subfolder}/` : ""}${folder}/${photo.filename}`,
        conflictAction: "uniquify",
        saveAs: false
      });
      downloaded += 1;
    } catch {
      failed += 1;
    }

    try {
      chrome.runtime.sendMessage(
        {
          type: "DOWNLOAD_PROGRESS",
          completed: downloaded + failed,
          total: photos.length
        },
        () => void chrome.runtime.lastError
      );
    } catch {
      // The popup may be closed while downloads continue.
    }

    await new Promise((resolve) => setTimeout(resolve, 650));
  }

  return { downloaded, failed };
}