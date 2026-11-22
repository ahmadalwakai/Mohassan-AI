/**
 * The only script a generated site ships: no network, no third party. It toggles the phone menu and,
 * when the contact form has no inbox endpoint, turns the filled form into a WhatsApp or mail message
 * the visitor sends themselves. Motion is CSS-only (scroll-driven), so nothing depends on this file.
 */
export function siteScript(): string {
  return `(function () {
  'use strict';
  document.documentElement.classList.add('js');
  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.nav-toggle');
  if (header && toggle) {
    toggle.addEventListener('click', function () {
      var open = header.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && header.classList.contains('nav-open')) { header.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
    });
    header.querySelectorAll('.site-nav a').forEach(function (link) {
      link.addEventListener('click', function () { header.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false'); });
    });
  }
  document.querySelectorAll('form[data-compose]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new FormData(form);
      var lines = [];
      form.querySelectorAll('.field').forEach(function (field) {
        var label = field.querySelector('span'), input = field.querySelector('input, textarea');
        if (label && input && input.value) lines.push(label.textContent + ': ' + input.value);
      });
      var body = lines.join('\\n');
      var whatsapp = form.getAttribute('data-whatsapp'), email = form.getAttribute('data-email'), subject = form.getAttribute('data-subject') || '';
      if (whatsapp) window.open('https://wa.me/' + whatsapp + '?text=' + encodeURIComponent(body), '_blank', 'noopener');
      else if (email) window.location.href = 'mailto:' + email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
      void data;
    });
  });
})();
`;
}
