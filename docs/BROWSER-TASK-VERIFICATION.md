# Browser task execution and verification

The task flow supports `browser.open`: open an explicit public HTTPS URL in an independent Chromium session, read the resulting page, and save a screenshot when available. Browser execution is enabled only when both execution and independent verification callbacks are configured. It does not submit forms, sign in, or manage Google Ads campaigns.

Previously, a request such as “افتح موقع Google Ads في المتصفح، واعرض لي لقطة من الصفحة بعد تحميلها” could remain a `system.diagnostic` task. A completed diagnostic proved only service health. Browser intent now selects the browser capability and an explicit URL. Older diagnostic results containing a browser request are labeled as diagnostic-only instead of evidence that a page opened.

## Evidence and scope

- The approved task stores its URL and exact allowed origins. Every network request and redirect is checked against that scope and the existing public-network/DNS policy. Sessions allow at most six origins.
- Execution requires the current task owner and worker lease. A unique durable receipt prevents an automatic duplicate attempt. Cancellation closes the owned browser session.
- A `browser_open` result includes the actual final URL, page title, observation ID/time, session ID, content hash, and explicit screenshot availability. Screenshot URL/hash are null when no image is available; the service makes one additional observation attempt before reporting that state.
- Independent verification compares the result with the task-bound receipt and original saved browser observation. The authenticated screenshot endpoint checks the owner and evidence hashes. The receipt preserves its image after later manual navigation in that session.

## HTTP redirects

Playwright does not re-enter a page route for every HTTP redirect hop. Passing a remote redirect directly to Chromium therefore reached the deliberate denial proxy instead of the pinned transport.

The engine now fulfills a main-frame redirect with an inert, sandboxed placeholder, validates the destination, and starts a fresh intercepted navigation. It follows at most five redirects within a bounded deadline and reports the genuine final browser URL. GET/HEAD resource redirects also use the pinned transport. Cross-origin redirects do not forward the original resource's cookies. Response CORS headers needed for explicitly allowed assets are retained.

An approved POST can receive a 303 receipt followed by a GET. A 307/308 redirect never replays that POST; its outcome remains unresolved rather than assuming success or sending it again.

## Actual public Google Ads check

On the UK network used for this check, `https://ads.google.com/home/` redirected to `https://consent.google.com/`, which displayed **Before you continue**. The localized Ads URL also redirected through the consent flow. A real engine run saved a valid 1100×760 JPEG and read 2,165 characters from that consent page. This establishes public navigation and image capture; it does not establish that the Ads homepage or an Ads account opened.

The observed origins were `https://ads.google.com`, `https://consent.google.com`, and the resource host `https://www.gstatic.com`. The consent page's account and policy links do not require adding those destinations to a reading session. No consent form was submitted and no Google login or campaign was accessed. The application UI check records its own final page title, URL, and screenshot rather than relabeling consent as the Ads homepage.

## Validation

`tests/browser-security.test.ts`, `tests/browser-control.test.ts`, and `tests/browser-task.test.ts`: **21 tests passed**. Server TypeScript checking also passed. These fixtures cover actual isolated Chromium navigation, final redirect URLs/cookies, redirected resources, POST receipt handling without replay, private-network denial, owner/lease boundaries, immutable screenshot receipts, tampering, cancellation, and honest missing-image results.

The Google Ads check used the public site through the same browser engine. It is separate from the controlled fixture tests. Full application, end-to-end, and restart checks are recorded by the integrating task.
