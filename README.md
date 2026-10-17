# Bhuvan Photo Collector

A Chrome extension for collecting photos from open asset details on Bhuvan-BHUGRAM. It works in the current browser session and saves image URLs with state, district, asset number, and the visible detail text.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project folder.
4. Open Bhuvan-BHUGRAM, select a state, district, one block, and the stage you need, then click **View** so the filtered point layer is loaded.
5. Open the extension and choose **Collect selected block**. Keep the popup open while it scans. It fits the map to the selected block, identifies green markers, and collects every stage-photo link returned for each asset.
6. Choose **Analyze collected photos** to look for readable Marathi/English board text. This OCR runs locally in the extension; the first use downloads and caches the language data.
7. Review the separate **Board photos** list, then choose **Download board photos** to save only those matches under `Downloads/Bhuvan/BoardPhotos/state/district`. The regular **Download photos** button still downloads every collected image.
8. To capture one photo manually instead, open its asset detail panel and choose **Capture open photo instead**.

Block collection uses Bhuvan's map identify flow sequentially; it does not use a bulk data endpoint. Keep the popup open until the progress message reports completion. Downloads are paced to avoid sending a burst of image requests. Marker scanning is based on the map's rendered green symbols, so verify the collected count for each block before relying on it as a complete inventory. Board detection looks for sufficient OCR text in Marathi/English, so review the board-only list; OCR may miss blurry or distant boards and may include other text-heavy images.