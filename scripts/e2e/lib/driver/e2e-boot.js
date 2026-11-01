// Opens the driver page, and nothing else.
//
// Appended to `background.scripts` in the copy of the build that the Firefox half of the
// pass loads. It has to be the background that opens the page: the page needs the
// extension's own origin to reach `browser.*`, and its moz-extension:// URL carries a UUID
// that is minted per profile, so nothing outside the browser can know it in advance.
(async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await browser.tabs.create({ url: browser.runtime.getURL("e2e.html"), active: true });
      return;
    } catch (err) {
      // The window may not exist yet in the first moments of a cold start.
      console.log(`[e2e] could not open the driver page yet: ${err}`);
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }
  console.log("[e2e] gave up opening the driver page");
})();
