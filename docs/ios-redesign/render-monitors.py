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


def check_approval(phone):
    card = phone.get_by_role("article", name="مقترح مراقبة")
    expect(card.get_by_role("heading", name="مقترح مراقبة")).to_be_visible()
    expect(card.locator("dt")).to_have_text([
        "المصدر", "ما يُراقَب", "القراءة الحالية", "شرط التنبيه",
        "الفاصل الأول بين الفحوص", "مدة المراقبة",
    ])
    expect(card.locator("time")).to_be_visible()
    expect(card.get_by_role("button")).to_have_text(["ابدأ المراقبة", "لا، شكرًا"])
    return card


def check_conversation(phone):
    card = phone.get_by_role("article", name="مراقبة حالة التسجيل في ورشة التصوير")
    expect(card.locator(".monitor-chip")).to_have_text("نشطة")
    expect(card.locator("dt")).to_have_text(["المصدر", "آخر فحص", "القراءة الحالية", "الفحص التالي"])
    expect(card.get_by_role("button")).to_have_text(["إيقاف مؤقت", "إيقاف المراقبة"])
    return card


def check_settings(phone):
    section = phone.get_by_role("region", name="المراقبات")
    expect(section.locator(".monitor-chip")).to_have_text(["نشطة", "متوقفة مؤقتًا", "تحقّق الشرط"])
    expect(section.get_by_role("button", name="افتح محادثة")).to_have_count(3)
    expect(section.get_by_role("button", name="إيقاف مؤقت")).to_be_visible()
    expect(section.get_by_role("button", name="استئناف")).to_be_visible()
    expect(section.get_by_role("button", name="إيقاف المراقبة")).to_have_count(2)
    return section


root = Path(__file__).resolve().parents[2]
docs = root / "docs/ios-redesign"
scenes = {
    "monitor-approval": check_approval,
    "monitor-conversation": check_conversation,
    "monitor-settings": check_settings,
}
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
        expect(page.locator("html")).to_have_attribute("lang", "ar")
        expect(page.locator("html")).to_have_attribute("dir", "rtl")
        assert page.evaluate("""async () => {
            await document.fonts.ready;
            const faces = await document.fonts.load('600 16px Alexandria', 'مقترح مراقبة');
            return faces.length > 0 && faces.every(face => face.status === 'loaded');
        }""")
        expect(page.locator('.phone[data-screen^="monitor-"]')).to_have_count(6)

        for theme in ("dark", "light"):
            for scene, check in scenes.items():
                phone = page.locator(f'[data-theme="{theme}"] .phone[data-screen="{scene}"]')
                phone.evaluate("phone => Object.assign(phone.style, { position: 'fixed', inset: '0 auto auto 0', zIndex: '5' })")
                expect(phone).to_have_css("direction", "rtl")
                expect(phone).to_have_css("color-scheme", theme)
                section = check(phone)
                scroller = phone.locator(".settings" if scene == "monitor-settings" else ".thread")
                bounds = section.bounding_box()
                viewport = scroller.bounding_box()
                assert viewport["y"] <= bounds["y"], (scene, bounds, viewport)
                assert bounds["y"] + bounds["height"] <= viewport["y"] + viewport["height"], (scene, bounds, viewport)
                assert section.evaluate("section => section.scrollWidth <= section.clientWidth"), scene
                for button in section.get_by_role("button").all():
                    hit_area = button.bounding_box()
                    assert hit_area["width"] >= 44 and hit_area["height"] >= 44

                path = docs / f"{scene}-{theme}.png"
                screenshot = phone.screenshot(path=path, animations="disabled")
                phone.evaluate("phone => phone.removeAttribute('style')")
                assert unpack(">II", screenshot[16:24]) == (1179, 2556)
                print(f"{path.relative_to(root)}: 1179 × 2556")

        assert not errors, errors
        print(f"RTL, Alexandria, monitor fields, settings order and touch targets passed on Chromium {browser.version}.")
        browser.close()
    server.shutdown()
