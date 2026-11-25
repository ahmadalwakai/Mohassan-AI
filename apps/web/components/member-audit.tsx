import { Button } from "@chakra-ui/react";
import type { CancelMemberDeletionResult, EndAccountSessionsResult, MemberAuditPage, PendingMemberDeletions } from "@mohassan/contracts";
import { RefreshCw } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { AccountLoading, AccountTime, ConfirmAccountAction, MemberAccountData, accountRequest, useAccountResource } from "./member-data-rights";
import styles from "./member-data-rights.module.css";

type MemberReference = { id: string; name: string };
type AuditEntry = MemberAuditPage["entries"][number];
const actionNames: Record<AuditEntry["action"], string> = {
  invite_created: "إنشاء دعوة",
  invite_used: "استخدام دعوة",
  invite_revoked: "إلغاء دعوة",
  member_suspended: "إيقاف عضو",
  member_unsuspended: "إعادة تفعيل عضو",
  deletion_requested: "طلب حذف حساب",
  deletion_cancelled: "إلغاء طلب حذف",
  deletion_purged: "حذف حساب نهائيًا",
  export_downloaded: "تنزيل نسخة البيانات",
};

export function MemberSessionActions({ member, offline, children }: { member: MemberReference; offline: boolean; children: ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  return <div className={styles.memberActions}>
    <div className={styles.actions}>
      {children}
      <Button size="sm" variant="outline" disabled={offline} onClick={() => { setNotice(""); setConfirm(true); }}>إنهاء جلسات العضو</Button>
    </div>
    {notice ? <small role="status">{notice}</small> : null}
    {confirm ? <ConfirmAccountAction title="إنهاء جلسات العضو" instruction={`سيُسجَّل خروج ${member.name} من جميع الأجهزة.`}
      label="تأكيد إنهاء الجلسات" close={() => setConfirm(false)} run={async () => {
        const path = `/api/members/${encodeURIComponent(member.id)}/sessions`;
        const result = await accountRequest<EndAccountSessionsResult>(path, { method: "DELETE" });
        setNotice(result.ended ? "أُنهيت جلسات العضو." : "لا توجد جلسات نشطة لهذا العضو.");
      }} /> : null}
  </div>;
}

function PendingRequests({ offline, onCancel }: { offline: boolean; onCancel: () => void }) {
  const heading = useId();
  const { value, error, reload } = useAccountResource<PendingMemberDeletions>("/api/members/deletions");
  const [selection, setSelection] = useState<PendingMemberDeletions["requests"][number]>();
  const [cancelled, setCancelled] = useState(false);
  return <section className="panel" aria-labelledby={heading}>
    <div className="panel-heading"><h2 id={heading}>طلبات حذف الحسابات</h2>
      <Button size="sm" variant="outline" aria-label="تحديث طلبات الحذف" disabled={offline || (!value && !error)} onClick={reload}><RefreshCw size={16} /></Button>
    </div>
    <div className={styles.body}>
      {value ? value.requests.length ? <ul className={styles.list}>
        {value.requests.map(request => <li key={request.userId}>
          <div className={styles.record}>
            <strong>{request.name}</strong>
            <bdi dir="ltr">{request.email}</bdi>
            <div className={styles.metadata}>
              <span>تاريخ الطلب <AccountTime value={request.requestedAt} /></span>
              <span>موعد الحذف <AccountTime value={request.purgeAfter} /></span>
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={offline} onClick={() => { setCancelled(false); setSelection(request); }}>إلغاء طلب الحذف</Button>
        </li>)}
      </ul> : <p>لا توجد طلبات حذف معلّقة.</p> : <AccountLoading error={error} retry={reload} />}
      {cancelled ? <p role="status">أُلغي طلب حذف الحساب.</p> : null}
    </div>
    {selection ? <ConfirmAccountAction title="إلغاء طلب حذف حساب عضو" instruction={`سيبقى حساب ${selection.name} وبياناته متاحين عند إلغاء الطلب.`}
      label="تأكيد الإلغاء" close={() => setSelection(undefined)} run={async () => {
        const path = `/api/members/deletions/${encodeURIComponent(selection.userId)}`;
        const result = await accountRequest<CancelMemberDeletionResult>(path, { method: "DELETE" });
        if (!result.cancelled) throw new Error("لم يعد هذا الطلب متاحًا للإلغاء.");
        reload();
        onCancel();
        setCancelled(true);
      }} /> : null}
  </section>;
}

function Identity({ id, names }: { id: string | null; names: ReadonlyMap<string, string> }) {
  if (id === null) return <>النظام</>;
  const name = names.get(id);
  return name ? <bdi title={id}>{name}</bdi> : <bdi dir="ltr" className={styles.identifier}>{id}</bdi>;
}

function AuditLog({ members, offline, revision }: { members: readonly MemberReference[]; offline: boolean; revision: number }) {
  const heading = useId();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const path = cursor ? `/api/members/audit?beforeId=${encodeURIComponent(cursor)}` : "/api/members/audit";
  const refresh = useMemo(() => ({ members, revision }), [members, revision]);
  const { value, error, reload } = useAccountResource<MemberAuditPage>(path, refresh);
  const names = new Map(members.map(member => [member.id, member.name]));
  return <section className="panel" aria-labelledby={heading}>
    <div className="panel-heading"><h2 id={heading}>سجل الأعضاء</h2>
      <Button size="sm" variant="outline" aria-label="تحديث سجل الأعضاء" disabled={offline || (!value && !error)} onClick={() => { setCursors([]); reload(); }}><RefreshCw size={16} /></Button>
    </div>
    <div className={styles.body}>
      {value ? value.entries.length ? <div className={styles.tableScroll} role="region" aria-labelledby={heading} tabIndex={0}>
        <table className={styles.table}>
          <thead><tr><th scope="col">الإجراء</th><th scope="col">المنفّذ</th><th scope="col">المعرّف المستهدف</th><th scope="col">الوقت</th></tr></thead>
          <tbody>{value.entries.map(entry => <tr key={entry.id}>
            <td>{actionNames[entry.action]}</td>
            <td><Identity id={entry.actorId} names={names} /></td>
            <td><Identity id={entry.targetId} names={names} /></td>
            <td><AccountTime value={entry.occurredAt} /></td>
          </tr>)}</tbody>
        </table>
      </div> : <p>لا توجد أحداث في السجل.</p> : <AccountLoading error={error} retry={reload} />}
      {cursor || value?.nextBeforeId ? <div className={styles.actions}>
        {cursor ? <Button size="sm" variant="outline" disabled={offline} onClick={() => setCursors(current => current.slice(0, -1))}>أحداث أحدث</Button> : null}
        {value?.nextBeforeId ? <Button size="sm" variant="outline" disabled={offline} onClick={() => setCursors(current => [...current, String(value.nextBeforeId)])}>أحداث أقدم</Button> : null}
      </div> : null}
    </div>
  </section>;
}

export function OwnerMemberHistory({ members, offline }: { members?: readonly MemberReference[]; offline: boolean }) {
  const [revision, setRevision] = useState(0);
  const refreshAudit = () => setRevision(current => current + 1);
  return <>
    <MemberAccountData offline={offline} onExported={refreshAudit} />
    {members ? <>
      <PendingRequests offline={offline} onCancel={refreshAudit} />
      <AuditLog members={members} revision={revision} offline={offline} />
    </> : null}
  </>;
}
