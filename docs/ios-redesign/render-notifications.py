from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from os import environ
from pathlib import Path
from struct import unpack
from threading import Thread

from playwright.sync_api import expect, sync_playwright


class MockupHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


root = Path(__file__).resolve().parents[2]
docs = root / "docs/ios-redesign"
with ThreadingHTTPServer(("127.0.0.1", 0), partial(MockupHandler, directory=root)) as server:
    Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"))
        page = browser.new_page(viewport={"width": 1280, "height": 1000}, device_scale_factor=3)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("requestfailed", lambda request: errors.append(request.url))
        page.on("response", lambda response: errors.append(response.url) if response.status >= 400 else None)
        page.goto(f"http://127.0.0.1:{server.server_port}/docs/ios-redesign/mockup.html", wait_until="networkidle")
        assert page.locator("html").get_attribute("lang") == "ar"
        assert page.locator("html").get_attribute("dir") == "rtl"
        assert page.evaluate("""async () => {
            await document.fonts.ready;
            const faces = await document.fonts.load('700 16px Alexandria', 'إشعارات المهام');
            return faces.length > 0 && faces.every(face => face.status === 'loaded');
        }""")
        expect(page.locator(".phone")).to_have_count(10)

        for theme in ("dark", "light"):
            for scene in ("notification-banner", "notification-settings"):
                phone = page.locator(f'[data-theme="{theme}"] .phone[data-screen="{scene}"]')
                expect(phone).to_have_css("direction", "rtl")
                expect(phone).to_have_css("color-scheme", theme)

                if scene == "notification-banner":
                    banner = phone.get_by_role("article", name="إشعار موحسن")
                    expect(banner.get_by_role("heading", name="اكتمل تلخيص التقرير")).to_be_visible()
                    expect(banner.get_by_text("اضغط لعرض النتيجة في المحادثة.")).to_be_visible()
                    assert banner.locator("img").evaluate("image => image.complete && image.naturalWidth > 0")
                    expect(phone.locator(".keyboard")).to_have_count(0)
                else:
                    section = phone.get_by_role("region", name="الإشعارات")
                    toggle = section.get_by_role("switch", name="إشعارات المهام")
                    expect(toggle).to_be_checked()
                    expect(section.get_by_text("مفعّل")).to_be_visible()
                    expect(section.get_by_text("بعد فتح القفل")).to_be_visible()
                    section_bounds = section.bounding_box()
                    phone_bounds = phone.bounding_box()
                    assert section_bounds["y"] + section_bounds["height"] < phone_bounds["y"] + phone_bounds["height"] - 8
                    toggle.click()
                    expect(toggle).not_to_be_checked()
                    toggle.click()
                    expect(toggle).to_be_checked()
                    phone.locator(".settings").evaluate("settings => { settings.scrollTop = 0; }")

                path = docs / f"{scene}-{theme}.png"
                phone.evaluate("phone => Object.assign(phone.style, { position: 'fixed', inset: '0 auto auto 0', zIndex: '5' })")
                screenshot = phone.screenshot(path=path, animations="disabled")
                phone.evaluate("phone => phone.removeAttribute('style')")
                assert unpack(">II", screenshot[16:24]) == (1179, 2556)
                print(f"{path.relative_to(root)}: 1179 × 2556")

        assert not errors, errors
        print(f"RTL, Alexandria, app icon, banner, settings, and switch checks passed on Chromium {browser.version}.")
        browser.close()
    server.shutdown()
