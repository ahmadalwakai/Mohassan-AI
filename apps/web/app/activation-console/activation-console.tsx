'use client';

import type { ActivationConsoleSnapshot } from '@mohassan/contracts';
import { useEffect, useState } from 'react';
import { activationPath, requestActivationConsole, type ActivationState } from './activation-data';
import { ActivationAccessMessage, ActivationFrame } from './activation-frame';
import styles from './activation-console.module.css';

type Switch = ActivationConsoleSnapshot['switches'][number];
const sections = [
  ['feature', 'مفاتيح الميزات'],
  ['configuration', 'إعدادات الخادم'],
  ['process', 'إعدادات عملية التشغيل'],
] as const;
const number = new Intl.NumberFormat('ar');
const date = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
// Production source retrieved on 2026-11-27.
const repository = 'https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/';

function Source({ reference }: { reference: string }) {
  const path = reference.startsWith(repository) ? reference.slice(repository.length) : reference;
  const [file, anchor] = path.split('#');
  if (!/^(apps|packages|docs|scripts)\/[\w./-]+$/.test(file ?? '') || file?.split('/').includes('..')) {
    return <code dir="ltr">{path}</code>;
  }
  const href = `${repository}${file}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
  return <a href={href}><code dir="ltr">{path}</code></a>;
}

function Value({ value, fallback = 'غير مضبوط' }: { value: string | null; fallback?: string }) {
  return value === null || value === '' ? <span className={styles.muted}>{fallback}</span> : <code dir="ltr">{value}</code>;
}

function SwitchDetails({ item, observationWindowDays }: { item: Switch; observationWindowDays: number }) {
  const { name, currentValue, ownerTrial, readers, dependencies, preflight, evidence, observation, risk, sources } = item;
  const defaults = [...new Set(readers.map(reader => reader.defaultValue))];
  return <details className={styles.switch}>
    <summary className={styles.summary}>
      <span className={styles.switchName}><code dir="ltr">{name}</code></span>
      <span className={styles.value}><small>القيمة الحالية</small><Value value={currentValue} /></span>
      <span className={styles.value}><small>الافتراضي</small>{defaults.length > 1 ? 'حسب الوحدة' : <Value value={defaults[0] ?? null} />}</span>
      <span className={styles.value}><small>تجربة المالك</small><Value value={ownerTrial} fallback="غير موثّقة" /></span>
    </summary>
    <dl className={styles.details}>
      <div>
        <dt>أثر التغيير</dt>
        <dd>{risk}</dd>
        {item.configuredValue !== null && item.configuredValue !== currentValue && <dd>
          القيمة المضبوطة في العملية <Value value={item.configuredValue} />
        </dd>}
      </div>
      <div>
        <dt>المفاتيح المرتبطة</dt>
        <dd>{dependencies.length ? <ul className={styles.dependencies}>{dependencies.map(name => <li key={name}><code dir="ltr">{name}</code></li>)}</ul> : 'لا توجد مفاتيح مرتبطة موثّقة.'}</dd>
      </div>
      <div>
        <dt>فحص النشر الموثّق</dt>
        <dd>{preflight ? <><Source reference={preflight.path} />{preflight.args.length > 0 && <code dir="ltr" className={styles.command}>{preflight.args.join(' ')}</code>}</> : 'لا يوجد فحص مخصّص موثّق.'}</dd>
      </div>
      <div>
        <dt>أحدث دليل موثّق</dt>
        <dd>{evidence ? <><p>{evidence.summary}</p><Source reference={evidence.path} /></> : 'لا يوجد مستند يربط هذا المفتاح بنتيجة قياس.'}</dd>
        {observation && <dd className={styles.observation}>
          آخر حدث في عيّنة الرصد <time dateTime={observation.lastObservedAt}>{date.format(new Date(observation.lastObservedAt))}</time> (UTC).
          {' '}في عيّنة آخر {number.format(observationWindowDays)} يومًا، ظهر {number.format(observation.eventCount)} حدث، و{number.format(observation.comparedCount)} مقارنة، و{number.format(observation.disagreements)} اختلاف، و{number.format(observation.errors)} خطأ.
        </dd>}
      </div>
      {sources.length > 0 && <div>
        <dt>مصادر الإعداد والمخاطر</dt>
        <dd><ul>{sources.map(source => <li key={source}><Source reference={source} /></li>)}</ul></dd>
      </div>}
      <div className={styles.readers}>
        <dt>قراءة المفتاح وإعادة التشغيل</dt>
        <dd><ul>{readers.map(reader => <li key={`${reader.module}:${reader.parsing}`}>
          <Source reference={reader.module} />
          <span>الافتراضي <Value value={reader.defaultValue} /></span>
          <code dir="ltr">{reader.parsing}</code>
          <strong>{reader.needsRestart ? 'يتطلّب إعادة التشغيل' : 'يُقرأ أثناء التشغيل'}</strong>
        </li>)}</ul></dd>
      </div>
    </dl>
  </details>;
}

export function ActivationConsole({ initialState }: { initialState: ActivationState }) {
  const [state, setState] = useState(initialState);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (state.kind !== 'loading') return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void requestActivationConsole(activationPath, { signal }).then(result => {
      if (!controller.signal.aborted) setState(result);
    });
    return () => controller.abort();
  }, [state.kind]);

  const reload = () => setState({ kind: 'loading' });

  const switches = state.kind === 'ready' ? state.snapshot.switches : [];
  const needle = query.trim().toLowerCase();
  const visible = switches.filter(item => item.name.toLowerCase().includes(needle));

  return <ActivationFrame>
    {state.kind === 'loading' && <p className={styles.message} role="status">جارٍ تحميل مفاتيح الإنتاج…</p>}
    {(state.kind === 'signin' || state.kind === 'forbidden') && <ActivationAccessMessage kind={state.kind} />}
    {state.kind === 'error' && <div className={styles.message}>
      <p role="alert">تعذّر تحميل مفاتيح الإنتاج.</p>
      <button type="button" onClick={reload}>إعادة المحاولة</button>
    </div>}
    {state.kind === 'ready' && <>
      <div className={styles.toolbar}>
        <p>القيم الحالية من عملية الخادم. هذه الصفحة للقراءة فقط.</p>
        <button type="button" onClick={reload}>تحديث القيم</button>
      </div>
      {switches.length > 0 ? <>
        <label className={styles.search}>البحث باسم المفتاح
          <input type="search" dir="ltr" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        {visible.length ? sections.map(([kind, title]) => {
          const items = visible.filter(item => item.kind === kind);
          return items.length > 0 && <section key={kind} aria-labelledby={`activation-${kind}`}>
            <h2 id={`activation-${kind}`} className={styles.sectionHeading}>{title}</h2>
            <div className={styles.list}>
              {items.map(item => <SwitchDetails item={item} observationWindowDays={state.snapshot.observationWindowDays} key={item.name} />)}
            </div>
          </section>;
        })
          : <p className={styles.message} role="status">لا توجد مفاتيح تطابق البحث.</p>}
      </> : <p className={styles.message} role="status">لا توجد مفاتيح إنتاج في السجل.</p>}
    </>}
  </ActivationFrame>;
}
