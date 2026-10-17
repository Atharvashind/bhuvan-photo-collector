function isVisible(element) {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function getDistrict(selectId) {
  const select = document.querySelector(selectId);
  return select?.selectedOptions[0]?.textContent?.trim() || "Unknown";
}

function getAssetId(panel) {
  for (const row of panel.querySelectorAll("tr")) {
    const cells = [...row.querySelectorAll("th, td")].map((cell) => cell.textContent.trim());
    if (cells.length > 1 && /^(sl\.?\s*no\.?|serial\s*no\.?)$/i.test(cells[0])) {
      return cells[1].replace(/[^a-z0-9_-]/gi, "").slice(0, 60);
    }
  }
  return "";
}

function getExtension(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.(jpe?g|png|webp|gif|bmp)$/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  } catch {
    return "jpg";
  }
}

function collectVisiblePhotos() {
  const panel = document.querySelector("#photodiv");
  if (!panel || !isVisible(panel)) {
    return { error: "Open an asset detail panel by clicking a map marker first." };
  }

  const state = getDistrict("#statecode");
  const district = getDistrict("#district");
  const assetId = getAssetId(panel);
  const panelText = (panel.innerText || panel.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1800);
  const photos = [...panel.querySelectorAll("img")]
    .filter((image) => isVisible(image) && image.naturalWidth >= 80 && image.naturalHeight >= 60)
    .map((image, index) => {
      const url = image.currentSrc || image.src;
      const extension = getExtension(url);
      const stageHint = [image.alt, image.title, image.parentElement?.innerText]
        .filter(Boolean)
        .join(" ")
        .match(/\b(stage\s*[123]|before|during|after)\b/i)?.[0] || "photo";
      const safe = (value) => value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50);
      const basename = [safe(state), safe(district), safe(assetId || "asset"), safe(stageHint), index + 1]
        .filter(Boolean)
        .join("-");

      return {
        key: `${url}|${state}|${district}|${assetId}`,
        url,
        state,
        district,
        assetId,
        stageHint,
        details: panelText,
        filename: `${basename}.${extension}`,
        capturedAt: new Date().toISOString()
      };
    });

  if (!photos.length) {
    return { error: "No loaded project photo found in the open asset panel." };
  }

  return { photos };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CAPTURE_VISIBLE_PHOTOS") return;
  sendResponse(collectVisiblePhotos());
});